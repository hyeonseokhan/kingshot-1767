/**
 * strategy Edge Function — KvK 전략 배정 서비스 백엔드.
 *
 * 인증: pnx-sk-auth-v1 세션 토큰 (kingshot_users.session_token).
 *   PIN 기반 인증 제거 — 통합 인증(kvk-survey login) 으로 발급된 토큰만 허용.
 *
 * 액션:
 *   { action: 'verify-access', token }
 *     → { ok, error? }
 *     토큰 유효성 + 1767 멤버 확인 + city_level >= 26 확인.
 *
 *   { action: 'lookup-player', player_id }
 *     → { ok, nickname, avatar_url, city_level? }
 *     킹샷 게임 API 로 최신 닉네임/아바타 조회 (인증 불필요).
 *
 *   { action: 'upsert-position', token, id, kingshot_id, nickname, avatar_url, city_level? }
 *     → { ok }
 *     strategy_admins 등록 관리자만 가능. 포지션 슬롯에 사람 배정.
 *
 *   { action: 'clear-position', token, id }
 *     → { ok }
 *     관리자만 가능. 포지션 슬롯 비우기.
 *
 *   { action: 'swap-positions', token, id_a, id_b }
 *     → { ok }
 *     관리자만 가능. 두 슬롯의 배정 인원 교체 (D&D 완료 시 호출).
 */

import { crypto as stdCrypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { encode as hexEncode } from "https://deno.land/std@0.168.0/encoding/hex.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// ── v1: 게임 공식 API ─────────────────────────────────────────────
const KS_API_BASE   = "https://kingshot-giftcode.centurygame.com/api";
const KS_API_SECRET = "mN4!pQs6JrYwV9";

// ── v2: 커뮤니티 트래커 API ───────────────────────────────────────
const JEAB_API_BASE = "https://kingshot.jeab.dev";

const dbHeaders: Record<string, string> = {
  apikey:        SERVICE_KEY,
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

async function dbPatch(path: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`db patch ${res.status}: ${await res.text()}`);
}

async function dbPost(table: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`db post ${res.status}: ${await res.text()}`);
}

async function dbPostReturn(table: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      ...dbHeaders,
      Prefer: "return=representation",
      Accept: "application/vnd.pgrst.object+json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`db post ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Crypto (게임 API 서명용) ─────────────────────────────────

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
  return md5(sorted + KS_API_SECRET);
}

// ─── 게임 API ────────────────────────────────────────────────

async function fetchGamePlayer(kingshotId: string): Promise<{ nickname: string; avatar_url: string | null } | null> {
  try {
    const params: Record<string, string | number> = { fid: kingshotId, time: Date.now() };
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
    return { nickname: json.data.nickname, avatar_url: json.data.avatar_image ?? null };
  } catch {
    return null;
  }
}

// ── v2 플레이어 조회 ──────────────────────────────────────────────

interface GamePlayerV2 {
  nickname:                string;
  avatar_url:              string | null;
  city_level:              number | null;
  state:                   number | null;
  power:                   number | null;
  life_tree_level:         number | null;
  alliance_id:             number | null;
  alliance_abbr:           string | null;
  alliance_name:           string | null;
  alliance_rank:           number | null;
  mystic_trial_score:      number | null;
  mystic_trial_rank:       number | null;
  mystic_trial_kid:        number | null;
  mystic_trial_updated_ts: number | null;
  v2_tag:                  string | null;
  v2_last_refreshed_at:    string | null;
}

async function fetchGamePlayerV2(kingshotId: string): Promise<GamePlayerV2 | null> {
  try {
    const res = await fetch(`${JEAB_API_BASE}/api/players/${encodeURIComponent(kingshotId)}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.id) return null;
    const avatarUrl = json.avatar_url ? `${JEAB_API_BASE}${json.avatar_url}` : null;
    return {
      nickname:                json.username           ?? "",
      avatar_url:              avatarUrl,
      city_level:              json.town_hall_level    ?? null,
      state:                   json.state              ?? null,
      power:                   json.power              ?? null,
      life_tree_level:         json.life_tree_level    ?? null,
      alliance_id:             json.alliance_id        ?? null,
      alliance_abbr:           json.alliance_abbr      ?? null,
      alliance_name:           json.alliance_name      ?? null,
      alliance_rank:           json.alliance_rank      ?? null,
      mystic_trial_score:      json.mystic_trial_score ?? null,
      mystic_trial_rank:       json.mystic_trial_rank  ?? null,
      mystic_trial_kid:        json.mystic_trial_kid   ?? null,
      mystic_trial_updated_ts: json.mystic_trial_updated_ts ?? null,
      v2_tag:                  json.tag                ?? null,
      v2_last_refreshed_at:    json.last_refreshed_at  ?? null,
    };
  } catch {
    return null;
  }
}

// ─── Validators ──────────────────────────────────────────────

function isValidPlayerId(id: unknown): id is string {
  return typeof id === "string" && /^\d+$/.test(id) && id.length <= 20;
}

function isValidToken(token: unknown): token is string {
  return typeof token === "string" && /^[0-9a-f-]{36}$/.test(token);
}

// ─── 인증 헬퍼 ───────────────────────────────────────────────

interface TokenUser {
  kingshot_id: string;
  city_level: number | null;
}

/** 세션 토큰 검증 → 유효하면 { kingshot_id, city_level } 반환, 무효·만료면 null. */
async function verifyToken(token: string): Promise<TokenUser | null> {
  const now = new Date().toISOString();
  const row = await dbSelectOne(
    `kingshot_users?session_token=eq.${encodeURIComponent(token)}&session_expires_at=gte.${now}&select=kingshot_id,city_level`,
  );
  return row ?? null;
}

/** 토큰 검증 + strategy_admins 등록 확인. 실패 시 throws. */
async function requireStrategyAdmin(token: unknown): Promise<TokenUser> {
  if (!isValidToken(token)) throw new Error("invalid_token");
  const user = await verifyToken(token);
  if (!user) throw new Error("invalid_token");
  const admin = await dbSelectOne(
    `strategy_admins?kingshot_id=eq.${encodeURIComponent(user.kingshot_id)}`,
  );
  if (!admin) throw new Error("not_admin");
  return user;
}

// ─── 메인 핸들러 ──────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const { action } = body;

  try {
    // ── verify-access ──────────────────────────────────────
    if (action === "verify-access") {
      const { token } = body;
      if (!isValidToken(token)) return json({ ok: false, error: "invalid_token" });

      const user = await verifyToken(token);
      if (!user) return json({ ok: false, error: "invalid_token" });

      const survey = await dbSelectOne(
        `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(user.kingshot_id)}&select=kingshot_id`,
      );
      if (!survey) return json({ ok: false, error: "not_member" });

      const lvl = user.city_level;
      if (!lvl || lvl < 26) {
        return json({ ok: false, error: "level_too_low", city_level: lvl });
      }

      return json({ ok: true });
    }

    // ── lookup-player ──────────────────────────────────────
    if (action === "lookup-player") {
      const { player_id } = body;
      if (!isValidPlayerId(player_id)) return json({ ok: false, error: "invalid_player_id" });

      // v2 호출 (v1: fetchGamePlayer 는 코드 유지)
      const player = await fetchGamePlayerV2(player_id as string);
      if (!player) return json({ ok: false, error: "player_not_found" });

      return json({
        ok:                      true,
        nickname:                player.nickname,
        avatar_url:              player.avatar_url,
        city_level:              player.city_level,
        // v2 확장 필드 — 상세보기 다이얼로그용
        state:                   player.state,
        power:                   player.power,
        life_tree_level:         player.life_tree_level,
        alliance_id:             player.alliance_id,
        alliance_abbr:           player.alliance_abbr,
        alliance_name:           player.alliance_name,
        alliance_rank:           player.alliance_rank,
        mystic_trial_score:      player.mystic_trial_score,
        mystic_trial_rank:       player.mystic_trial_rank,
        mystic_trial_kid:        player.mystic_trial_kid,
        mystic_trial_updated_ts: player.mystic_trial_updated_ts,
        v2_tag:                  player.v2_tag,
        v2_last_refreshed_at:    player.v2_last_refreshed_at,
      });
    }

    // ── upsert-position ────────────────────────────────────
    if (action === "upsert-position") {
      const { token, id, kingshot_id, nickname, avatar_url, city_level, power, alliance_abbr } = body;
      if (typeof id !== "number") return json({ ok: false, error: "invalid_id" });

      await requireStrategyAdmin(token);

      await dbPatch(`strategy_assignments?id=eq.${id}`, {
        kingshot_id:   kingshot_id   ?? null,
        nickname:      nickname      ?? null,
        avatar_url:    avatar_url    ?? null,
        city_level:    city_level    ?? null,
        power:         power         ?? null,
        alliance_abbr: alliance_abbr ?? null,
      });

      return json({ ok: true });
    }

    // ── clear-position ─────────────────────────────────────
    if (action === "clear-position") {
      const { token, id } = body;
      if (typeof id !== "number") return json({ ok: false, error: "invalid_id" });

      await requireStrategyAdmin(token);

      await dbPatch(`strategy_assignments?id=eq.${id}`, {
        kingshot_id:   null,
        nickname:      null,
        avatar_url:    null,
        city_level:    null,
        power:         null,
        alliance_abbr: null,
      });

      return json({ ok: true });
    }

    // ── swap-positions ─────────────────────────────────────
    if (action === "swap-positions") {
      const { token, id_a, id_b } = body;
      if (typeof id_a !== "number" || typeof id_b !== "number") {
        return json({ ok: false, error: "invalid_id" });
      }
      if (id_a === id_b) return json({ ok: false, error: "same_position" });

      await requireStrategyAdmin(token);

      const rows = await dbSelect(
        `strategy_assignments?id=in.(${id_a},${id_b})&select=id,kingshot_id,nickname,avatar_url,city_level,power,alliance_abbr`,
      );
      if (rows.length !== 2) return json({ ok: false, error: "position_not_found" });

      const a = rows.find((r: any) => r.id === id_a)!;
      const b = rows.find((r: any) => r.id === id_b)!;

      await dbPatch(`strategy_assignments?id=eq.${id_a}`, {
        kingshot_id:   b.kingshot_id,
        nickname:      b.nickname,
        avatar_url:    b.avatar_url,
        city_level:    b.city_level,
        power:         b.power         ?? null,
        alliance_abbr: b.alliance_abbr ?? null,
      });
      await dbPatch(`strategy_assignments?id=eq.${id_b}`, {
        kingshot_id:   a.kingshot_id,
        nickname:      a.nickname,
        avatar_url:    a.avatar_url,
        city_level:    a.city_level,
        power:         a.power         ?? null,
        alliance_abbr: a.alliance_abbr ?? null,
      });

      return json({ ok: true });
    }

    // ── refresh-all-positions ──────────────────────────────
    if (action === "refresh-all-positions") {
      const { token } = body;
      await requireStrategyAdmin(token);

      // 킹샷 ID 가 배정된 슬롯만 조회
      const rows = await dbSelect(
        `strategy_assignments?kingshot_id=not.is.null&select=id,kingshot_id`,
      );

      // 동일 플레이어가 여러 슬롯에 있을 수 있으므로 kid → [id, ...] 로 묶기
      const byKid = new Map<string, number[]>();
      for (const r of rows) {
        if (!byKid.has(r.kingshot_id)) byKid.set(r.kingshot_id, []);
        byKid.get(r.kingshot_id)!.push(r.id);
      }

      let refreshed = 0;
      let failed    = 0;

      for (const [kid, ids] of byKid) {
        const player = await fetchGamePlayerV2(kid);
        if (!player) { failed++; continue; }

        // strategy_assignments 갱신 (모든 슬롯)
        for (const id of ids) {
          await dbPatch(`strategy_assignments?id=eq.${id}`, {
            nickname:      player.nickname,
            avatar_url:    player.avatar_url,
            city_level:    player.city_level,
            power:         player.power         ?? null,
            alliance_abbr: player.alliance_abbr ?? null,
          });
        }

        // kingshot_users 도 최신 v2 데이터로 갱신
        await dbPatch(`kingshot_users?kingshot_id=eq.${encodeURIComponent(kid)}`, {
          nickname:                player.nickname,
          avatar_url:              player.avatar_url,
          city_level:              player.city_level,
          state:                   player.state,
          power:                   player.power,
          life_tree_level:         player.life_tree_level,
          alliance_id:             player.alliance_id,
          alliance_abbr:           player.alliance_abbr,
          alliance_name:           player.alliance_name,
          alliance_rank:           player.alliance_rank,
          mystic_trial_score:      player.mystic_trial_score,
          mystic_trial_rank:       player.mystic_trial_rank,
          mystic_trial_kid:        player.mystic_trial_kid,
          mystic_trial_updated_ts: player.mystic_trial_updated_ts,
          v2_tag:                  player.v2_tag,
          v2_last_refreshed_at:    player.v2_last_refreshed_at,
        });

        refreshed++;
      }

      return json({ ok: true, refreshed, failed });
    }

    // ── chat-fetch ─────────────────────────────────────────
    if (action === "chat-fetch") {
      const rows = await dbSelect(
        "strategy_chat?select=id,kingshot_id,nickname,avatar_url,message,created_at&order=created_at.desc&limit=80",
      );
      return json({ ok: true, messages: rows.reverse() });
    }

    // ── chat-send ──────────────────────────────────────────
    if (action === "chat-send") {
      const { token, message } = body;
      if (!isValidToken(token)) return json({ ok: false, error: "invalid_token" });
      if (typeof message !== "string" || message.trim().length === 0) {
        return json({ ok: false, error: "invalid_message" });
      }
      const text = message.trim().slice(0, 200);

      const user = await verifyToken(token);
      if (!user) return json({ ok: false, error: "invalid_token" });

      const userRow = await dbSelectOne(
        `kingshot_users?kingshot_id=eq.${encodeURIComponent(user.kingshot_id)}&select=nickname,avatar_url,last_chat_at`,
      );
      if (!userRow) return json({ ok: false, error: "invalid_token" });

      // 5분 레이트 리밋
      if (userRow.last_chat_at) {
        const diffMs = Date.now() - new Date(userRow.last_chat_at).getTime();
        const limitMs = 5 * 60 * 1000;
        if (diffMs < limitMs) {
          return json({
            ok: false,
            error: "rate_limited",
            retry_after: Math.ceil((limitMs - diffMs) / 1000),
          });
        }
      }

      const now = new Date().toISOString();
      const newMsg = await dbPostReturn("strategy_chat", {
        kingshot_id: user.kingshot_id,
        nickname:    userRow.nickname,
        avatar_url:  userRow.avatar_url ?? null,
        message:     text,
      });
      await dbPatch(
        `kingshot_users?kingshot_id=eq.${encodeURIComponent(user.kingshot_id)}`,
        { last_chat_at: now },
      );

      return json({ ok: true, message: newMsg });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    const KNOWN = new Set(["invalid_token", "not_admin", "position_not_found", "same_position", "rate_limited"]);
    if (KNOWN.has(msg)) return json({ ok: false, error: msg });
    console.error(`[strategy] unexpected error action=${action}`, err);
    return json({ ok: false, error: "unexpected_error" }, 500);
  }
});
