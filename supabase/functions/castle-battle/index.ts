/**
 * castle-battle Edge Function — 캐슬 전투 베팅 서비스의 백엔드.
 *
 * 인증 모델:
 *   - 일반 사용자 액션: 매 호출마다 (player_id, pin) 동봉 → verifyAuth 로 PIN 검증.
 *   - 운영자 액션: PIN 검증 후 members.is_admin 컬럼 확인 (cb_admins 테이블 제거됨).
 *
 * 액션 (사용자):
 *   { action: 'get-current-round' }                                  → { ok, round?, targets[], candidates[], votes_counts[] }
 *   { action: 'cast-vote', player_id, pin, target_id, candidate_id } → { ok }
 *   { action: 'my-votes', player_id, pin, round_id }                 → { ok, votes[] }
 *
 * 액션 (운영자):
 *   { action: 'admin-setup-round', player_id, pin, title, event_starts_at, memo?,
 *             targets: [{slot, is_open, candidates:[{alliance_tag, alliance_name?, rallier_nickname, kingshot_id?}]}] }
 *                                                                      → { ok, round_id }
 *   { action: 'admin-create-round',     player_id, pin, title, event_starts_at, memo? }  → { ok, round_id }
 *   { action: 'admin-set-round-status', player_id, pin, round_id, status }                → { ok }
 *   { action: 'admin-set-target-open',  player_id, pin, target_id, is_open }              → { ok }
 *   { action: 'admin-add-candidate',    player_id, pin, target_id, alliance_id,
 *                                       rallier_nickname, kingshot_id? }                  → { ok, candidate_id }
 *   { action: 'admin-remove-candidate', player_id, pin, candidate_id }                     → { ok }
 *   { action: 'admin-enter-result',     player_id, pin, target_id, winning_candidate_id? } → { ok }
 *   { action: 'admin-list-alliances',   player_id, pin }                                   → { ok, alliances[] }
 *   { action: 'admin-add-alliance',     player_id, pin, tag, name }                       → { ok, alliance_id }
 *
 * 비즈니스 룰:
 *   - 회차 동시 active 1개 — cb_rounds 부분 unique index 로 DB 레벨 강제.
 *   - 투표 변경 불가 — cb_votes UNIQUE (target_id, voter_kingshot_id) 로 중복 차단.
 *   - 부분 투표 허용 — 미투표 거점은 row 없음.
 *   - 상태 전이: preparing → voting → voting_closed → results_in → archived (이전 단계로 회귀 불가, EF 에서 검증).
 *   - voting 상태에서만 cast-vote 허용. results_in 상태에서만 admin-enter-result 허용.
 */

import { crypto as stdCrypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { encode as hexEncode } from "https://deno.land/std@0.168.0/encoding/hex.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// 게임 공식 player 조회 API (tile-match-auth 와 동일 endpoint/secret)
const KS_API_BASE = "https://kingshot-giftcode.centurygame.com/api";
const KS_API_SECRET = "mN4!pQs6JrYwV9";

const dbHeaders: Record<string, string> = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

// ─── DB 헬퍼 ─────────────────────────────────────────────────

async function dbSelectOne(path: string): Promise<any | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { ...dbHeaders, Accept: "application/vnd.pgrst.object+json" },
  });
  if (res.status === 406) return null;
  if (!res.ok) throw new Error(`db select ${res.status}: ${await res.text()}`);
  return res.json();
}

async function dbSelect(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: dbHeaders });
  if (!res.ok) throw new Error(`db select ${res.status}: ${await res.text()}`);
  return res.json();
}

async function dbInsert(table: string, body: Record<string, unknown>, returning = false): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      ...dbHeaders,
      Prefer: returning ? "return=representation" : "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`db insert ${table} ${res.status}: ${text}`);
  }
  return returning ? res.json() : null;
}

async function dbPatch(path: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`db patch ${res.status}: ${await res.text()}`);
}

async function dbDelete(path: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
  });
  if (!res.ok) throw new Error(`db delete ${res.status}: ${await res.text()}`);
}

// ─── crypto ──────────────────────────────────────────────────

async function sha256Hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── 게임 API ────────────────────────────────────────────────

async function md5(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const hash = await stdCrypto.subtle.digest("MD5", data);
  return new TextDecoder().decode(hexEncode(new Uint8Array(hash)));
}

async function makeSign(params: Record<string, string | number>): Promise<string> {
  const sorted = Object.keys(params)
    .filter((k) => k !== "sign")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return await md5(sorted + KS_API_SECRET);
}

interface GamePlayerInfo {
  nickname: string;
  avatar_image: string | null;
}

async function fetchGamePlayer(kingshotId: string): Promise<GamePlayerInfo | null> {
  try {
    const params = { fid: kingshotId, time: Date.now() };
    const sign = await makeSign(params);
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) body.set(k, String(v));
    body.set("sign", sign);
    const res = await fetch(`${KS_API_BASE}/player`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0 || !json.data) return null;
    return { nickname: json.data.nickname, avatar_image: json.data.avatar_image ?? null };
  } catch {
    return null;
  }
}

async function upsertRallier(kingshotId: string, nickname: string, profilePhoto: string | null): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cb_ralliers`, {
    method: "POST",
    headers: {
      ...dbHeaders,
      Prefer: "return=minimal,resolution=merge-duplicates",
    },
    body: JSON.stringify({ kingshot_id: kingshotId, nickname, profile_photo: profilePhoto, synced_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    console.warn(`[castle-battle] upsertRallier failed ${res.status}: ${await res.text()}`);
  }
}

// ─── validators ──────────────────────────────────────────────

function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}

function isValidPlayerId(id: unknown): id is string {
  return typeof id === "string" && /^\d+$/.test(id) && id.length <= 20;
}

const VALID_STATUSES = ["preparing", "voting", "voting_closed", "results_in", "archived"];

// 상태 전이 규칙.
// voting_closed → voting 은 운영자가 "투표 마감"을 실수로 눌렀을 때의 undo 용 — 허용.
// 그 외 역방향 전이는 금지.
const STATUS_TRANSITIONS: Record<string, string[]> = {
  preparing: ["voting"],
  voting: ["voting_closed"],
  voting_closed: ["voting", "results_in"],
  results_in: ["archived"],
  archived: [],
};

// ─── 알려진 에러 ──────────────────────────────────────────────

const KNOWN_ERRORS = new Set([
  "missing_field", "invalid_pin", "invalid_player_id", "invalid_status",
  "not_registered", "wrong_pin", "not_admin",
  "no_active_round", "round_not_found", "target_not_found",
  "candidate_not_found", "alliance_not_found",
  "invalid_status_transition", "round_not_in_voting",
  "round_not_in_results_in", "target_closed",
  "already_voted", "candidate_target_mismatch",
  "duplicate_alliance_tag", "duplicate_candidate",
]);

function maskError(err: unknown, ctx: { action: string; playerId?: string | null }): {
  ok: false;
  error: string;
} {
  const raw = String((err as Error)?.message ?? err);
  if (KNOWN_ERRORS.has(raw)) return { ok: false, error: raw };
  console.error(
    `[castle-battle] unexpected error action=${ctx.action} player_id=${ctx.playerId ?? "-"} message=${raw}`,
  );
  return { ok: false, error: "unexpected_error" };
}

// ─── 인증 ────────────────────────────────────────────────────

interface AuthResult {
  player_id: string;
  nickname: string;
  is_admin: boolean;
}

/** PIN 검증 → 멤버 정보 + is_admin 반환. is_admin 은 members.is_admin 컬럼 사용. */
async function verifyAuth(playerId: unknown, pin: unknown): Promise<AuthResult> {
  if (!isValidPlayerId(playerId)) throw new Error("invalid_player_id");
  if (!isValidPin(pin)) throw new Error("invalid_pin");

  const cred = await dbSelectOne(
    `member_credentials?player_id=eq.${encodeURIComponent(playerId)}&select=pin_hash,pin_salt`,
  );
  if (!cred) throw new Error("not_registered");

  const computed = await sha256Hex(pin + cred.pin_salt);
  if (computed !== cred.pin_hash) throw new Error("wrong_pin");

  const member = await dbSelectOne(
    `members?kingshot_id=eq.${encodeURIComponent(playerId)}&select=kingshot_id,nickname,is_admin`,
  );
  if (!member) throw new Error("not_registered");

  return {
    player_id: member.kingshot_id,
    nickname: member.nickname,
    is_admin: !!member.is_admin,
  };
}

async function requireAdmin(playerId: unknown, _pin: unknown): Promise<AuthResult> {
  // 관리자 액션은 PIN 재검증 없이 player_id + DB is_admin 컬럼만 확인.
  // 투표/정보조회 같은 사용자 액션은 verifyAuth(pin 포함)를 그대로 사용.
  if (!isValidPlayerId(playerId)) throw new Error("invalid_player_id");
  const member = await dbSelectOne(
    `members?kingshot_id=eq.${encodeURIComponent(playerId)}&select=kingshot_id,nickname,is_admin`,
  );
  if (!member) throw new Error("not_registered");
  if (!member.is_admin) throw new Error("not_admin");
  return { player_id: member.kingshot_id, nickname: member.nickname, is_admin: true };
}

// ─── 회차 / 거점 / 후보 / 투표 ─────────────────────────────────

/** 현재 active 회차 1개 (archived 제외). 없으면 null. */
async function getActiveRound(): Promise<any | null> {
  const rows = await dbSelect(
    `cb_rounds?status=in.(preparing,voting,voting_closed,results_in)` +
      `&select=*&order=created_at.desc&limit=1`,
  );
  return rows[0] ?? null;
}

/** 회차 단위 전체 컨텍스트 (거점/후보/집계). 비활성 회차여도 조회 가능. */
async function getRoundContext(roundId: number) {
  const targets = await dbSelect(
    `cb_targets?round_id=eq.${roundId}&select=*&order=id.asc`,
  );
  const targetIds = targets.map((t) => t.id);
  if (targetIds.length === 0) {
    return { targets, candidates: [], vote_counts: [] };
  }
  const targetFilter = `target_id=in.(${targetIds.join(",")})`;

  const candidates = await dbSelect(
    `cb_candidates?${targetFilter}&select=*&order=target_id.asc,display_order.asc,id.asc`,
  );
  const vote_counts = await dbSelect(
    `cb_vote_counts?${targetFilter}&select=*`,
  );
  return { targets, candidates, vote_counts };
}

async function getCurrentRound() {
  const round = await getActiveRound();
  if (!round) return { ok: true, round: null, targets: [], candidates: [], vote_counts: [] };
  const ctx = await getRoundContext(round.id);
  return { ok: true, round, ...ctx };
}

/** 회차 생성 + 5개 거점 자동 초기화 (모두 is_open=true, 자유전투는 운영자가 토글). */
async function adminCreateRound(
  playerId: unknown,
  pin: unknown,
  title: unknown,
  eventStartsAt: unknown,
  memo: unknown,
) {
  const me = await requireAdmin(playerId, pin);
  if (typeof title !== "string" || title.length === 0 || title.length > 200) {
    throw new Error("missing_field");
  }
  if (typeof eventStartsAt !== "string" || !eventStartsAt) {
    throw new Error("missing_field");
  }
  // 동시 active 1개 보장은 DB unique index 가 강제 — 충돌 시 PG 에러를 KNOWN 으로 마스킹 X
  // (사용자에게는 unexpected_error 로 노출. 운영자가 알아서 archive 후 재시도)

  const round = await dbInsert(
    "cb_rounds",
    {
      title,
      event_starts_at: eventStartsAt,
      memo: typeof memo === "string" ? memo : null,
      created_by: me.player_id,
    },
    true,
  ) as any[];
  const roundId = round[0].id as number;

  // 5 거점 INSERT (cardinal 슬롯명)
  const SLOTS = ["castle", "turret_north", "turret_east", "turret_south", "turret_west"];
  for (const slot of SLOTS) {
    await dbInsert("cb_targets", { round_id: roundId, slot });
  }
  return { ok: true, round_id: roundId };
}

/**
 * admin-setup-round: 회차 + 거점 설정 + 후보 등록을 한 번에 처리.
 * targets 배열의 각 항목: { slot, is_open, candidates?: [{alliance_tag, alliance_name?, rallier_nickname, kingshot_id?}] }
 * 연맹은 tag 기준으로 upsert — 없으면 name(없으면 tag)으로 신규 생성.
 * 타이틀은 자동 생성: "n회차 캐슬전투" (전체 회차 수 기반).
 */
async function adminSetupRound(
  playerId: unknown,
  pin: unknown,
  eventStartsAt: unknown,
  memo: unknown,
  targets: unknown,
) {
  const me = await requireAdmin(playerId, pin);
  if (typeof eventStartsAt !== "string" || !eventStartsAt) throw new Error("missing_field");

  // 회차 번호 자동 생성
  const allRounds = await dbSelect("cb_rounds?select=id");
  const roundNum = allRounds.length + 1;
  const title = `${roundNum}회차 캐슬전투`;

  const round = await dbInsert(
    "cb_rounds",
    {
      title,
      event_starts_at: eventStartsAt,
      memo: typeof memo === "string" ? memo : null,
      created_by: me.player_id,
    },
    true,
  ) as any[];
  const roundId = round[0].id as number;

  const SLOTS = ["castle", "turret_north", "turret_east", "turret_south", "turret_west"];
  const targetsArr = Array.isArray(targets) ? targets : [];

  for (const slot of SLOTS) {
    const cfg = targetsArr.find((t: any) => t.slot === slot);
    const isOpen = cfg ? !!cfg.is_open : true;
    const targetRow = await dbInsert("cb_targets", { round_id: roundId, slot, is_open: isOpen }, true) as any[];
    const targetId = targetRow[0].id as number;

    if (!isOpen || !Array.isArray(cfg?.candidates)) continue;

    let order = 1;
    for (const cand of cfg.candidates) {
      if (!cand?.rallier_nickname || !cand?.alliance_tag) continue;

      // 연맹 조회 또는 생성
      let alliance = await dbSelectOne(
        `cb_alliances?tag=eq.${encodeURIComponent(cand.alliance_tag)}&select=id`,
      );
      if (!alliance) {
        const newA = await dbInsert(
          "cb_alliances",
          { tag: cand.alliance_tag, name: cand.alliance_name || cand.alliance_tag },
          true,
        ) as any[];
        alliance = { id: newA[0].id };
      }

      const ksId = typeof cand.kingshot_id === "string" && cand.kingshot_id ? cand.kingshot_id : null;

      // cb_ralliers upsert — 집결자 프로필 캐시
      if (ksId && cand.rallier_nickname) {
        upsertRallier(ksId, cand.rallier_nickname, cand.profile_photo ?? null).catch(() => {});
      }

      try {
        await dbInsert("cb_candidates", {
          target_id: targetId,
          alliance_id: alliance.id,
          rallier_nickname: cand.rallier_nickname,
          kingshot_id: ksId,
          display_order: order++,
        });
      } catch {
        // 중복 후보 무시
      }
    }
  }

  return { ok: true, round_id: roundId };
}

/** lookup-player: 킹샷 ID 로 게임 API 조회 → cb_ralliers upsert → 프로필 반환. 인증 불필요 (공개 API). */
async function lookupPlayer(kingshotId: unknown) {
  if (typeof kingshotId !== "string" || !/^\d{4,15}$/.test(kingshotId)) {
    return { ok: false, error: "invalid_player_id" };
  }
  const info = await fetchGamePlayer(kingshotId);
  if (!info) return { ok: false, error: "player_not_found" };
  upsertRallier(kingshotId, info.nickname, info.avatar_image).catch(() => {});
  return { ok: true, nickname: info.nickname, profile_photo: info.avatar_image };
}

async function adminSetRoundStatus(
  playerId: unknown,
  pin: unknown,
  roundId: unknown,
  status: unknown,
) {
  const me = await requireAdmin(playerId, pin);
  if (typeof roundId !== "number" || !Number.isInteger(roundId)) {
    throw new Error("missing_field");
  }
  if (typeof status !== "string" || !VALID_STATUSES.includes(status)) {
    throw new Error("invalid_status");
  }
  const round = await dbSelectOne(`cb_rounds?id=eq.${roundId}&select=status`);
  if (!round) throw new Error("round_not_found");

  const allowed = STATUS_TRANSITIONS[round.status] ?? [];
  if (!allowed.includes(status)) throw new Error("invalid_status_transition");

  const patch: Record<string, unknown> = { status };
  // 정방향 전이만 타임스탬프 갱신.
  // preparing → voting: voting_opened_at 최초 기록.
  // voting → voting_closed: voting_closed_at 기록.
  // voting_closed → voting (undo): voting_closed_at NULL 로 클리어. voting_opened_at 은 보존.
  // voting_closed → results_in: results_entered_at 기록.
  if (round.status === "preparing" && status === "voting") {
    patch.voting_opened_at = new Date().toISOString();
  }
  if (round.status === "voting" && status === "voting_closed") {
    patch.voting_closed_at = new Date().toISOString();
  }
  if (round.status === "voting_closed" && status === "voting") {
    patch.voting_closed_at = null;
  }
  if (round.status === "voting_closed" && status === "results_in") {
    patch.results_entered_at = new Date().toISOString();
  }

  await dbPatch(`cb_rounds?id=eq.${roundId}`, patch);
  void me;
  return { ok: true };
}

async function adminSetTargetOpen(
  playerId: unknown,
  pin: unknown,
  targetId: unknown,
  isOpen: unknown,
) {
  await requireAdmin(playerId, pin);
  if (typeof targetId !== "number" || !Number.isInteger(targetId)) {
    throw new Error("missing_field");
  }
  if (typeof isOpen !== "boolean") throw new Error("missing_field");

  const target = await dbSelectOne(
    `cb_targets?id=eq.${targetId}&select=id,round_id`,
  );
  if (!target) throw new Error("target_not_found");

  // preparing 상태일 때만 거점 토글 가능 — 투표 시작 후 변경 금지
  const round = await dbSelectOne(
    `cb_rounds?id=eq.${target.round_id}&select=status`,
  );
  if (!round || round.status !== "preparing") throw new Error("invalid_status_transition");

  await dbPatch(`cb_targets?id=eq.${targetId}`, { is_open: isOpen });
  return { ok: true };
}

async function adminAddAlliance(
  playerId: unknown,
  pin: unknown,
  tag: unknown,
  name: unknown,
) {
  await requireAdmin(playerId, pin);
  if (typeof tag !== "string" || tag.length === 0 || tag.length > 20) {
    throw new Error("missing_field");
  }
  if (typeof name !== "string" || name.length === 0 || name.length > 100) {
    throw new Error("missing_field");
  }
  // 중복 tag → DB unique 위반
  try {
    const row = await dbInsert("cb_alliances", { tag, name }, true) as any[];
    return { ok: true, alliance_id: row[0].id };
  } catch (err) {
    const msg = String((err as Error).message);
    if (msg.includes("duplicate key") || msg.includes("cb_alliances_tag_key")) {
      throw new Error("duplicate_alliance_tag");
    }
    throw err;
  }
}

async function adminListAlliances(playerId: unknown, pin: unknown) {
  await requireAdmin(playerId, pin);
  const rows = await dbSelect(`cb_alliances?select=*&order=tag.asc`);
  return { ok: true, alliances: rows };
}

async function adminAddCandidate(
  playerId: unknown,
  pin: unknown,
  targetId: unknown,
  allianceId: unknown,
  rallierNickname: unknown,
  candidateKingshotId: unknown,
) {
  await requireAdmin(playerId, pin);
  if (typeof targetId !== "number" || !Number.isInteger(targetId)) {
    throw new Error("missing_field");
  }
  if (typeof allianceId !== "number" || !Number.isInteger(allianceId)) {
    throw new Error("missing_field");
  }
  if (typeof rallierNickname !== "string" || rallierNickname.length === 0 || rallierNickname.length > 50) {
    throw new Error("missing_field");
  }

  const target = await dbSelectOne(
    `cb_targets?id=eq.${targetId}&select=id,round_id,is_open`,
  );
  if (!target) throw new Error("target_not_found");
  if (!target.is_open) throw new Error("target_closed");

  const round = await dbSelectOne(`cb_rounds?id=eq.${target.round_id}&select=status`);
  if (!round || (round.status !== "preparing" && round.status !== "voting")) {
    // preparing 또는 voting 중에는 추가 가능 (운영자 재량). voting_closed 이후엔 금지.
    throw new Error("invalid_status_transition");
  }

  const alliance = await dbSelectOne(
    `cb_alliances?id=eq.${allianceId}&select=id`,
  );
  if (!alliance) throw new Error("alliance_not_found");

  try {
    const row = await dbInsert(
      "cb_candidates",
      {
        target_id: targetId,
        alliance_id: allianceId,
        rallier_nickname: rallierNickname,
        kingshot_id: typeof candidateKingshotId === "string" && candidateKingshotId ? candidateKingshotId : null,
      },
      true,
    ) as any[];
    return { ok: true, candidate_id: row[0].id };
  } catch (err) {
    const msg = String((err as Error).message);
    if (msg.includes("duplicate key") || msg.includes("cb_candidates_target_id_alliance_id_rallier_nickname_key")) {
      throw new Error("duplicate_candidate");
    }
    throw err;
  }
}

async function adminRemoveCandidate(
  playerId: unknown,
  pin: unknown,
  candidateId: unknown,
) {
  await requireAdmin(playerId, pin);
  if (typeof candidateId !== "number" || !Number.isInteger(candidateId)) {
    throw new Error("missing_field");
  }
  const cand = await dbSelectOne(
    `cb_candidates?id=eq.${candidateId}&select=id,target_id`,
  );
  if (!cand) throw new Error("candidate_not_found");

  const target = await dbSelectOne(`cb_targets?id=eq.${cand.target_id}&select=round_id`);
  const round = target
    ? await dbSelectOne(`cb_rounds?id=eq.${target.round_id}&select=status`)
    : null;
  if (!round || round.status !== "preparing") throw new Error("invalid_status_transition");

  await dbDelete(`cb_candidates?id=eq.${candidateId}`);
  return { ok: true };
}

async function castVote(
  playerId: unknown,
  pin: unknown,
  targetId: unknown,
  candidateId: unknown,
) {
  const me = await verifyAuth(playerId, pin);
  if (typeof targetId !== "number" || !Number.isInteger(targetId)) {
    throw new Error("missing_field");
  }
  if (typeof candidateId !== "number" || !Number.isInteger(candidateId)) {
    throw new Error("missing_field");
  }

  const target = await dbSelectOne(
    `cb_targets?id=eq.${targetId}&select=id,round_id,is_open`,
  );
  if (!target) throw new Error("target_not_found");
  if (!target.is_open) throw new Error("target_closed");

  const round = await dbSelectOne(`cb_rounds?id=eq.${target.round_id}&select=id,status`);
  if (!round) throw new Error("round_not_found");
  if (round.status !== "voting") throw new Error("round_not_in_voting");

  const candidate = await dbSelectOne(
    `cb_candidates?id=eq.${candidateId}&select=id,target_id`,
  );
  if (!candidate) throw new Error("candidate_not_found");
  if (candidate.target_id !== targetId) throw new Error("candidate_target_mismatch");

  try {
    await dbInsert("cb_votes", {
      round_id: round.id,
      target_id: targetId,
      candidate_id: candidateId,
      voter_kingshot_id: me.player_id,
    });
    return { ok: true };
  } catch (err) {
    const msg = String((err as Error).message);
    if (msg.includes("duplicate key") || msg.includes("cb_votes_target_id_voter_kingshot_id_key")) {
      throw new Error("already_voted");
    }
    throw err;
  }
}

async function myVotes(playerId: unknown, pin: unknown, roundId: unknown) {
  const me = await verifyAuth(playerId, pin);
  if (typeof roundId !== "number" || !Number.isInteger(roundId)) {
    throw new Error("missing_field");
  }
  const rows = await dbSelect(
    `cb_votes?round_id=eq.${roundId}&voter_kingshot_id=eq.${encodeURIComponent(me.player_id)}` +
      `&select=target_id,candidate_id,created_at`,
  );
  return { ok: true, votes: rows };
}

async function adminEnterResult(
  playerId: unknown,
  pin: unknown,
  targetId: unknown,
  winningCandidateId: unknown,
) {
  const me = await requireAdmin(playerId, pin);
  if (typeof targetId !== "number" || !Number.isInteger(targetId)) {
    throw new Error("missing_field");
  }

  const target = await dbSelectOne(
    `cb_targets?id=eq.${targetId}&select=id,round_id`,
  );
  if (!target) throw new Error("target_not_found");

  const round = await dbSelectOne(`cb_rounds?id=eq.${target.round_id}&select=status`);
  if (!round) throw new Error("round_not_found");
  if (round.status !== "results_in") throw new Error("round_not_in_results_in");

  let winnerId: number | null = null;
  if (winningCandidateId !== null && winningCandidateId !== undefined) {
    if (typeof winningCandidateId !== "number" || !Number.isInteger(winningCandidateId)) {
      throw new Error("missing_field");
    }
    const cand = await dbSelectOne(
      `cb_candidates?id=eq.${winningCandidateId}&select=id,target_id`,
    );
    if (!cand) throw new Error("candidate_not_found");
    if (cand.target_id !== targetId) throw new Error("candidate_target_mismatch");
    winnerId = winningCandidateId;
  }

  // UPSERT — 이미 결과 입력된 거점은 덮어씀 (실수 정정)
  const existing = await dbSelectOne(`cb_results?target_id=eq.${targetId}&select=target_id`);
  if (existing) {
    await dbPatch(`cb_results?target_id=eq.${targetId}`, {
      winning_candidate_id: winnerId,
      entered_by: me.player_id,
      entered_at: new Date().toISOString(),
    });
  } else {
    await dbInsert("cb_results", {
      target_id: targetId,
      winning_candidate_id: winnerId,
      entered_by: me.player_id,
    });
  }
  return { ok: true };
}

async function adminUpdateRound(
  playerId: unknown,
  pin: unknown,
  roundId: unknown,
  eventStartsAt: unknown,
): Promise<{ ok: boolean }> {
  await requireAdmin(playerId, pin);
  if (typeof roundId !== "number" || !eventStartsAt) throw new Error("missing_field");
  await dbPatch(`cb_rounds?id=eq.${roundId}`, { event_starts_at: eventStartsAt });
  return { ok: true };
}

async function adminDeleteRound(
  playerId: unknown,
  pin: unknown,
  roundId: unknown,
): Promise<{ ok: boolean }> {
  await requireAdmin(playerId, pin);
  if (typeof roundId !== "number") throw new Error("missing_field");
  // 연쇄 삭제: votes → candidates → targets → rounds
  await dbDelete(`cb_votes?round_id=eq.${roundId}`);
  const targets = await dbSelect(`cb_targets?round_id=eq.${roundId}&select=id`);
  for (const t of targets) {
    await dbDelete(`cb_candidates?target_id=eq.${t.id}`);
  }
  await dbDelete(`cb_targets?round_id=eq.${roundId}`);
  await dbDelete(`cb_rounds?id=eq.${roundId}`);
  return { ok: true };
}

async function adminResetVotes(
  playerId: unknown,
  pin: unknown,
  roundId: unknown,
): Promise<{ ok: boolean }> {
  await requireAdmin(playerId, pin);
  if (typeof roundId !== "number") throw new Error("missing_field");
  await dbDelete(`cb_votes?round_id=eq.${roundId}`);
  await dbPatch(`cb_rounds?id=eq.${roundId}`, { status: "preparing" });
  return { ok: true };
}

async function adminGetRoundDetail(playerId: unknown, pin: unknown): Promise<{ ok: boolean; round: any; targets: any[] }> {
  await requireAdmin(playerId, pin);
  const rounds = await dbSelect(
    "cb_rounds?status=not.eq.archived&order=id.desc&limit=1&select=id,title,event_starts_at,status",
  );
  const round = rounds[0] ?? null;
  if (!round) return { ok: true, round: null, targets: [] };

  const targets = await dbSelect(
    `cb_targets?round_id=eq.${round.id}&select=id,slot,is_open&order=id.asc`,
  );
  const targetIds = targets.map((t: any) => t.id).join(",");
  const candidates = targetIds
    ? await dbSelect(
        `cb_candidates?target_id=in.(${targetIds})&select=id,target_id,alliance_tag,rallier_nickname,kingshot_id&order=id.asc`,
      )
    : [];

  const ksids = [...new Set(
    candidates.filter((c: any) => c.kingshot_id).map((c: any) => c.kingshot_id),
  )];
  const rallierMap: Record<string, string> = {};
  if (ksids.length) {
    const ralliers = await dbSelect(
      `cb_ralliers?kingshot_id=in.(${ksids.map((k) => encodeURIComponent(k as string)).join(",")})&select=kingshot_id,profile_photo`,
    );
    for (const r of ralliers) rallierMap[r.kingshot_id] = r.profile_photo ?? "";
  }

  const enriched = targets.map((t: any) => ({
    target_id: t.id,
    slot: t.slot,
    is_open: t.is_open,
    candidates: candidates
      .filter((c: any) => c.target_id === t.id)
      .map((c: any) => ({
        candidate_id: c.id,
        alliance_tag: c.alliance_tag ?? "",
        rallier_nickname: c.rallier_nickname ?? "",
        kingshot_id: c.kingshot_id ?? null,
        profile_photo: c.kingshot_id ? (rallierMap[c.kingshot_id] ?? null) : null,
      })),
  }));

  return { ok: true, round, targets: enriched };
}

async function adminAddCandidateFull(
  playerId: unknown,
  pin: unknown,
  targetId: unknown,
  allianceTag: unknown,
  rallierNickname: unknown,
  kingshotId: unknown,
  profilePhoto: unknown,
): Promise<{ ok: boolean; candidate_id: number }> {
  await requireAdmin(playerId, pin);
  if (typeof targetId !== "number" || !allianceTag || !rallierNickname) throw new Error("missing_field");

  const target = await dbSelectOne(`cb_targets?id=eq.${targetId}&select=id,round_id`);
  if (!target) throw new Error("target_not_found");

  let alliance = await dbSelectOne(
    `cb_alliances?tag=eq.${encodeURIComponent(allianceTag as string)}&select=id`,
  );
  if (!alliance) {
    const rows = await dbInsert("cb_alliances", { tag: allianceTag, name: allianceTag }, true);
    alliance = (rows as any[])[0];
  }

  const rows = await dbInsert(
    "cb_candidates",
    {
      target_id: targetId,
      alliance_id: alliance.id,
      alliance_tag: allianceTag,
      rallier_nickname: rallierNickname,
      kingshot_id: kingshotId || null,
    },
    true,
  );
  const candidate = (rows as any[])[0];

  if (kingshotId && rallierNickname) {
    await upsertRallier(kingshotId as string, rallierNickname as string, (profilePhoto as string) ?? null);
  }

  return { ok: true, candidate_id: candidate.id };
}

// ─── 서버 ────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_body" }, 400);
  }
  const action = body?.action as string | undefined;
  const ctx = { action: action ?? "?", playerId: body?.player_id ?? null };

  try {
    let result: { ok: boolean; [k: string]: unknown };
    switch (action) {
      // 공개 조회
      case "get-current-round":
        result = await getCurrentRound();
        break;

      // 사용자
      case "cast-vote":
        result = await castVote(body.player_id, body.pin, body.target_id, body.candidate_id);
        break;
      case "my-votes":
        result = await myVotes(body.player_id, body.pin, body.round_id);
        break;

      // 공개 조회 (인증 불필요)
      case "lookup-player":
        result = await lookupPlayer(body.kingshot_id);
        break;

      // 운영자
      case "admin-setup-round":
        result = await adminSetupRound(
          body.player_id, body.pin, body.event_starts_at, body.memo, body.targets,
        );
        break;
      case "admin-create-round":
        result = await adminCreateRound(body.player_id, body.pin, body.title, body.event_starts_at, body.memo);
        break;
      case "admin-set-round-status":
        result = await adminSetRoundStatus(body.player_id, body.pin, body.round_id, body.status);
        break;
      case "admin-set-target-open":
        result = await adminSetTargetOpen(body.player_id, body.pin, body.target_id, body.is_open);
        break;
      case "admin-add-alliance":
        result = await adminAddAlliance(body.player_id, body.pin, body.tag, body.name);
        break;
      case "admin-list-alliances":
        result = await adminListAlliances(body.player_id, body.pin);
        break;
      case "admin-add-candidate":
        result = await adminAddCandidate(
          body.player_id, body.pin, body.target_id, body.alliance_id, body.rallier_nickname, body.kingshot_id,
        );
        break;
      case "admin-remove-candidate":
        result = await adminRemoveCandidate(body.player_id, body.pin, body.candidate_id);
        break;
      case "admin-enter-result":
        result = await adminEnterResult(body.player_id, body.pin, body.target_id, body.winning_candidate_id);
        break;
      case "admin-update-round":
        result = await adminUpdateRound(body.player_id, body.pin, body.round_id, body.event_starts_at);
        break;
      case "admin-delete-round":
        result = await adminDeleteRound(body.player_id, body.pin, body.round_id);
        break;
      case "admin-reset-votes":
        result = await adminResetVotes(body.player_id, body.pin, body.round_id);
        break;
      case "admin-get-round-detail":
        result = await adminGetRoundDetail(body.player_id, body.pin);
        break;
      case "admin-add-candidate-full":
        result = await adminAddCandidateFull(
          body.player_id, body.pin, body.target_id,
          body.alliance_tag, body.rallier_nickname, body.kingshot_id, body.profile_photo,
        );
        break;

      default:
        result = { ok: false, error: "unknown_action" };
    }
    return jsonResponse(result, result.ok ? 200 : 400);
  } catch (err) {
    const masked = maskError(err, ctx);
    return jsonResponse(masked, 400);
  }
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
