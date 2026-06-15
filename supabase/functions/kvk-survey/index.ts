/**
 * kvk-survey Edge Function
 *
 * KVK 가속권 보유량 설문 (survey.kingshot.wooju-home.org/kvk) 의 백엔드.
 * kvk_speedup_survey 테이블은 anon 차단 → 본 함수 (service_role) 만 접근.
 *
 * 액션:
 *   { action: "lookup",       kingshot_id }                                          → { ok, player, registered }
 *   { action: "login",        kingshot_id, pin }                                     → { ok, token, expires_at, record }
 *   { action: "verify-token", token }                                                → { ok, record }   (boot 자동)
 *   { action: "logout",       token }                                                → { ok }            (DB session_token NULL 처리, best-effort)
 *   { action: "register",     kingshot_id, pin, training, construction, general }    → { ok, token, expires_at, record }
 *   { action: "update",       token, training, construction, general }               → { ok }
 *                            (또는 백워드 호환: kingshot_id, pin, training, ...)
 *   { action: "set-evidence", token, has_evidence: boolean }                         → { ok, evidence_uploaded_at }
 *                            클라가 Storage 업로드/삭제 끝낸 후 호출.
 *                            has_evidence=true → now() 로 갱신, false → NULL.
 *   { action: "delete",       token }                                                → { ok }
 *                            (또는 백워드 호환: kingshot_id, pin)
 *                            row 삭제와 함께 Storage 의 kvk-survey/{id}.webp 도 service_role 로 삭제.
 *   { action: "verify",       kingshot_id, pin }                                     → { ok, record }  (deprecated)
 *   { action: "list",         token }                                                → { ok, items: [...] }  (인증 필수, pin_hash/salt/token 제외)
 *
 * evidence_uploaded_at: 인증샷 마지막 업로드 시점. NULL=미인증. Storage path 는 deterministic
 *                       (`kvk-survey/{kingshot_id}.webp` in `blacklist-evidence` bucket).
 *
 * pin: 정확히 4자리 숫자. SHA-256(pin + 16바이트 hex salt) 로 저장.
 * token: UUID v4 (DB 컬럼 session_token). 만료 = session_expires_at (90일).
 * nickname/avatar 는 lookup 시점에 게임 공식 API 로 직접 조회 → 위변조 차단.
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

// ── v1: 게임 공식 player 조회 API ────────────────────────────────────
// centurygame endpoint. redeem-coupon 과 동일 SECRET/sign 패턴.
// 이전 구현은 redeem-coupon Edge Function 을 proxy 호출했으나, internal Edge Function 간
// fetch 가 silent fail 하는 케이스 발생 (270680423 lookup 이 player_not_found 반환) →
// 직접 호출로 전환해 의존성 제거. SECRET 은 redeem-coupon 과 동일 (동일 endpoint).
const KS_API_BASE = "https://kingshot-giftcode.centurygame.com/api";
const KS_API_SECRET = "mN4!pQs6JrYwV9";

// ── v2: 커뮤니티 트래커 API ──────────────────────────────────────────
// kingshot.jeab.dev — 인증 없음, GET 단순 호출.
// city_level 은 town_hall_level 로 대체 (v1 stove_lv 보다 정확함을 확인).
const JEAB_API_BASE = "https://kingshot.jeab.dev";

const dbHeaders: Record<string, string> = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

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

async function dbInsert(table: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`db insert ${res.status}: ${await res.text()}`);
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

/** Storage 의 인증샷 파일 (`kvk-survey/{kingshot_id}.webp`) 삭제.
 *  bucket = blacklist-evidence (공용). 404 (파일 없음) 는 무시 — 이미 깨끗.
 *  delete 액션이 row 삭제와 함께 호출 → 고아 발생 차단. */
const EVIDENCE_BUCKET = "survey-evidence";
async function deleteEvidenceObject(kingshotId: string): Promise<void> {
  const path = `${kingshotId}.webp`;
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${EVIDENCE_BUCKET}/${path}`,
    { method: "DELETE", headers: dbHeaders },
  );
  // 404 / 400 (파일 없음) 은 무시 — 이미 없는 게 의도된 상태.
  if (!res.ok && res.status !== 404 && res.status !== 400) {
    throw new Error(`storage delete ${res.status}: ${await res.text()}`);
  }
}

async function sha256Hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomSaltHex(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 설문 등록 마감 시각 — 클라 (src/lib/kvk-survey/survey-deadline.ts) 및
 * kvk-buff/index.ts:DEADLINE_ISO 와 수동 동기화 필수.
 *
 * 마감 후 차단 대상: register / update / set-evidence (가속권 데이터·인증샷 변경 일체).
 * 차단 제외: lookup / login / verify-token / logout / list / delete (조회·인증·삭제는 마감 후도 허용).
 *
 * 변경 절차: 세 곳(클라/buff/survey) DEADLINE 동시 변경 + i18n 마감 안내문 갱신 + 두 함수 재배포.
 */
const DEADLINE_ISO = "2026-06-14T00:00:00Z";

/** 현재 시각이 마감을 지났으면 true. */
function isPastDeadline(): boolean {
  return Date.now() >= new Date(DEADLINE_ISO).getTime();
}

function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}

function isValidKingshotId(id: unknown): id is string {
  return typeof id === "string" && /^\d{4,15}$/.test(id);
}

function isNonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 9_999_999;
}

// ===== 세션 토큰 =====
// 90일 — 자주 안 쓰는 사용자도 분기마다 재로그인. 너무 짧으면 사용성 ↓, 너무 길면 보안 ↓.
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function newToken(): string {
  return crypto.randomUUID();
}

function newExpiresAt(): string {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

function isValidToken(t: unknown): t is string {
  return typeof t === "string" && /^[0-9a-f-]{36}$/i.test(t);
}

/** session_expires_at 이 과거면 true. NULL 은 무효 (만료된 것으로 처리). */
function isTokenExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return true;
  return new Date(expiresAt) <= new Date();
}

/**
 * 요청 헤더에서 클라이언트 IP / 국가 / 플랫폼 추출.
 *   - 클라이언트는 어떤 값도 송수신하지 않음 (DevTools 노출 X)
 *   - Cloudflare/Supabase 인프라가 자동으로 부착하는 헤더만 신뢰
 *   - country  : Cloudflare cf-ipcountry — ISO 3166-1 alpha-2 (예: 'KR')
 *   - platform : sec-ch-ua-platform 헤더 — Chrome/Edge 만 부착, Safari/Firefox NULL
 *                예: 'Android', 'iOS', 'Windows', 'macOS', 'Linux'
 */
function extractRequestMeta(
  req: Request,
): { ip: string | null; country: string | null; platform: string | null } {
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    null;
  const country = req.headers.get("cf-ipcountry") ?? null;
  // sec-ch-ua-platform 은 따옴표 포함된 값이라 (예: '"Android"') strip
  const platform = req.headers.get("sec-ch-ua-platform")?.replace(/^"|"$/g, "") || null;
  return { ip, country, platform };
}

// ── v1 PlayerInfo 인터페이스 (원본 유지) ─────────────────────────────
interface PlayerInfo {
  fid: string;
  nickname: string;
  avatar_image: string | null;
  city_level: number | null;
}

// ── v2 PlayerInfoV2 인터페이스 ───────────────────────────────────────
// PlayerInfo 와 동일한 핵심 필드 + v2 확장 필드.
// city_level 은 v2 town_hall_level 을 그대로 매핑.
interface PlayerInfoV2 extends PlayerInfo {
  state: number | null;
  power: number | null;
  life_tree_level: number | null;
  alliance_id: number | null;
  alliance_abbr: string | null;
  alliance_name: string | null;
  alliance_rank: number | null;
  mystic_trial_score: number | null;
  mystic_trial_rank: number | null;
  mystic_trial_kid: number | null;
  mystic_trial_updated_ts: number | null;
  v2_tag: string | null;
  v2_last_refreshed_at: string | null;
}

/** TC(센터) 레벨 게이트 — 이 값 이상만 설문 참여 가능. */
const MIN_CITY_LEVEL = 26;

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

/**
 * 게임 공식 player 조회 — centurygame /api/player 직접 호출.
 * 이전 구현은 redeem-coupon Edge Function 을 proxy 했으나 internal call 이 fail 하는
 * 케이스가 있어 직접 호출로 단순화. sign 패턴은 redeem-coupon 과 동일.
 */
async function fetchPlayerInfo(kingshotId: string): Promise<PlayerInfo | null> {
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
    // stove_lv 가 메인 필드. 일부 응답에서 stove_lv_content 만 채워질 수 있어 fallback
    // (members.ts 와 동일 패턴).
    const cityLevel =
      typeof json.data.stove_lv === "number"
        ? json.data.stove_lv
        : typeof json.data.stove_lv_content === "number"
        ? json.data.stove_lv_content
        : null;
    return {
      fid: String(json.data.fid),
      nickname: json.data.nickname,
      avatar_image: json.data.avatar_image ?? null,
      city_level: cityLevel,
    };
  } catch {
    return null;
  }
}

/**
 * v2 player 조회 — kingshot.jeab.dev/api/players/{id}.
 * PlayerInfoV2 로 정규화하여 반환. 미등록·오류 시 null.
 * avatar_url 은 JEAB_API_BASE prefix 를 붙여 절대 URL 로 변환.
 */
async function fetchPlayerInfoV2(kingshotId: string): Promise<PlayerInfoV2 | null> {
  try {
    const res = await fetch(`${JEAB_API_BASE}/api/players/${encodeURIComponent(kingshotId)}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.id) return null;
    const avatarUrl = json.avatar_url ? `${JEAB_API_BASE}${json.avatar_url}` : null;
    return {
      fid:                      String(json.id),
      nickname:                 json.username ?? "",
      avatar_image:             avatarUrl,
      city_level:               json.town_hall_level ?? null,
      state:                    json.state              ?? null,
      power:                    json.power              ?? null,
      life_tree_level:          json.life_tree_level    ?? null,
      alliance_id:              json.alliance_id        ?? null,
      alliance_abbr:            json.alliance_abbr      ?? null,
      alliance_name:            json.alliance_name      ?? null,
      alliance_rank:            json.alliance_rank      ?? null,
      mystic_trial_score:       json.mystic_trial_score ?? null,
      mystic_trial_rank:        json.mystic_trial_rank  ?? null,
      mystic_trial_kid:         json.mystic_trial_kid   ?? null,
      mystic_trial_updated_ts:  json.mystic_trial_updated_ts ?? null,
      v2_tag:                   json.tag                ?? null,
      v2_last_refreshed_at:     json.last_refreshed_at  ?? null,
    };
  } catch {
    return null;
  }
}

async function lookup(kingshotId: string) {
  if (!isValidKingshotId(kingshotId)) return { ok: false, error: "invalid_id" };
  // v2 호출 (v1: fetchPlayerInfo 는 코드 유지)
  const player = await fetchPlayerInfoV2(kingshotId);
  if (!player) return { ok: false, error: "player_not_found" };
  const existing = await dbSelectOne(
    `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(kingshotId)}&select=kingshot_id`
  );
  // 기존 등록자라면 lookup 시점에 프로필 즉시 sync — v2 확장 필드 포함.
  // updated_at 은 손대지 않음 (가속권 데이터 갱신 시점만 의미 있는 값).
  if (existing) {
    await dbPatch(`kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(kingshotId)}`, {
      nickname:                player.nickname,
      avatar_url:              player.avatar_image,
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
  }
  return {
    ok: true,
    player: {
      kingshot_id: player.fid,
      nickname:    player.nickname,
      avatar_url:  player.avatar_image,
      city_level:  player.city_level,
    },
    registered: !!existing,
  };
}

async function register(
  kingshotId: string,
  pin: unknown,
  training: unknown,
  construction: unknown,
  general: unknown,
  meta: { ip: string | null; country: string | null; platform: string | null },
) {
  if (isPastDeadline()) return { ok: false, error: "past_deadline" };
  if (!isValidKingshotId(kingshotId)) return { ok: false, error: "invalid_id" };
  if (!isValidPin(pin)) return { ok: false, error: "invalid_pin" };
  if (!isNonNegInt(training) || !isNonNegInt(construction) || !isNonNegInt(general)) {
    return { ok: false, error: "invalid_amount" };
  }
  const existing = await dbSelectOne(
    `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(kingshotId)}&select=kingshot_id`
  );
  if (existing) return { ok: false, error: "already_registered" };
  // v2 호출 (v1: fetchPlayerInfo 는 코드 유지)
  const player = await fetchPlayerInfoV2(kingshotId);
  if (!player) return { ok: false, error: "player_not_found" };
  // 서버측 게이트 — 클라이언트 우회 차단. lookup 통과 후 register 까지 시간 차에
  // 강등됐을 가능성도 막음 (정상 시나리오는 변화 없음).
  if (player.city_level === null || player.city_level < MIN_CITY_LEVEL) {
    return { ok: false, error: "city_level_too_low", city_level: player.city_level };
  }
  const salt = randomSaltHex();
  const hash = await sha256Hex((pin as string) + salt);
  const token = newToken();
  const expiresAt = newExpiresAt();
  await dbInsert("kvk_speedup_survey", {
    kingshot_id:             kingshotId,
    nickname:                player.nickname,
    avatar_url:              player.avatar_image,
    city_level:              player.city_level,
    pin_hash:                hash,
    pin_salt:                salt,
    training:                training as number,
    construction:            construction as number,
    general:                 general as number,
    ip:                      meta.ip,
    country:                 meta.country,
    platform:                meta.platform,
    session_token:           token,
    session_expires_at:      expiresAt,
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
  return {
    ok: true,
    token,
    expires_at: expiresAt,
    record: {
      kingshot_id: kingshotId,
      nickname: player.nickname,
      avatar_url: player.avatar_image,
      training: training as number,
      construction: construction as number,
      general: general as number,
      evidence_uploaded_at: null, // 신규 등록 시점엔 항상 미인증
      is_admin: false, // 신규 등록 시점엔 항상 일반 사용자 — 별도 SQL 로 부여
    },
  };
}

/**
 * PIN verify + 신규 세션 토큰 발급. 기존 등록자 전용 (행 없으면 not_registered).
 * 새 토큰을 발급하면서 기존 토큰은 덮어쓰기 → 다른 디바이스에서 자동 로그아웃 효과.
 */
async function login(kingshotId: string, pin: unknown) {
  if (!isValidKingshotId(kingshotId)) return { ok: false, error: "invalid_id" };
  if (!isValidPin(pin)) return { ok: false, error: "invalid_pin" };
  const row = await dbSelectOne(
    `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(kingshotId)}&select=pin_hash,pin_salt,training,construction,general,nickname,avatar_url,evidence_uploaded_at,is_admin`
  );
  if (!row) return { ok: false, error: "not_registered" };
  const computed = await sha256Hex((pin as string) + row.pin_salt);
  if (computed !== row.pin_hash) return { ok: false, error: "invalid_pin" };
  const token = newToken();
  const expiresAt = newExpiresAt();
  await dbPatch(
    `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(kingshotId)}`,
    { session_token: token, session_expires_at: expiresAt },
  );
  return {
    ok: true,
    token,
    expires_at: expiresAt,
    record: {
      kingshot_id: kingshotId,
      nickname: row.nickname,
      avatar_url: row.avatar_url,
      training: row.training,
      construction: row.construction,
      general: row.general,
      evidence_uploaded_at: row.evidence_uploaded_at ?? null,
      is_admin: row.is_admin === true,
    },
  };
}

/**
 * 명시적 로그아웃 — DB 의 session_token, session_expires_at 을 NULL 처리해 즉시 무효화.
 * 무효한 토큰이거나 PATCH 실패해도 ok 응답 (클라는 어차피 로컬 cleanup 진행).
 * 같은 ID 로 재로그인하면 새 token 발급되므로 별도 정리 불필요.
 */
async function logout(token: unknown) {
  if (!isValidToken(token)) return { ok: true };
  try {
    await dbPatch(
      `kvk_speedup_survey?session_token=eq.${encodeURIComponent(token as string)}`,
      { session_token: null, session_expires_at: null },
    );
  } catch (e) {
    // best-effort — 클라는 어차피 로컬 정리 진행
    console.error("logout patch failed (ignored):", (e as Error).message);
  }
  return { ok: true };
}

/**
 * 클라이언트 boot 시 자동 호출. 토큰 유효성 + 만료 + city_level 게이트 모두 검사.
 * 만료/무효면 클라에서 토큰 제거 + 로그인 다이얼로그.
 */
async function verifyToken(token: unknown) {
  if (!isValidToken(token)) return { ok: false, error: "invalid_token" };
  const row = await dbSelectOne(
    `kvk_speedup_survey?session_token=eq.${encodeURIComponent(token)}&select=kingshot_id,nickname,avatar_url,training,construction,general,city_level,evidence_uploaded_at,session_expires_at,is_admin`
  );
  if (!row) return { ok: false, error: "invalid_token" };
  if (isTokenExpired(row.session_expires_at)) return { ok: false, error: "token_expired" };
  // city_level 강등 가드 — 토큰 발급 후 게임에서 강등됐을 가능성
  if (row.city_level === null || row.city_level < MIN_CITY_LEVEL) {
    return { ok: false, error: "city_level_too_low", city_level: row.city_level };
  }
  return {
    ok: true,
    record: {
      kingshot_id: row.kingshot_id,
      nickname: row.nickname,
      avatar_url: row.avatar_url,
      training: row.training,
      construction: row.construction,
      general: row.general,
      evidence_uploaded_at: row.evidence_uploaded_at ?? null,
      is_admin: row.is_admin === true,
    },
  };
}

/** mutation 의 인증 — token 우선, 없으면 pin+kingshot_id (백워드 호환). 행 반환. */
async function authenticate(opts: {
  token?: unknown;
  kingshotId?: unknown;
  pin?: unknown;
}): Promise<{ ok: true; kingshotId: string } | { ok: false; error: string }> {
  if (isValidToken(opts.token)) {
    const row = await dbSelectOne(
      `kvk_speedup_survey?session_token=eq.${encodeURIComponent(opts.token as string)}&select=kingshot_id,session_expires_at`
    );
    if (!row) return { ok: false, error: "invalid_token" };
    if (isTokenExpired(row.session_expires_at)) return { ok: false, error: "token_expired" };
    return { ok: true, kingshotId: row.kingshot_id };
  }
  // 백워드 호환 — 구버전 클라이언트가 PIN 으로 직접 호출
  if (!isValidKingshotId(opts.kingshotId) || !isValidPin(opts.pin)) {
    return { ok: false, error: "missing_auth" };
  }
  const row = await dbSelectOne(
    `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(opts.kingshotId as string)}&select=pin_hash,pin_salt`
  );
  if (!row) return { ok: false, error: "not_registered" };
  const computed = await sha256Hex((opts.pin as string) + row.pin_salt);
  if (computed !== row.pin_hash) return { ok: false, error: "invalid_pin" };
  return { ok: true, kingshotId: opts.kingshotId as string };
}

async function verifyPin(kingshotId: string, pin: unknown) {
  if (!isValidKingshotId(kingshotId)) return { ok: false, error: "invalid_id" };
  if (!isValidPin(pin)) return { ok: false, error: "invalid_pin" };
  const row = await dbSelectOne(
    `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(kingshotId)}&select=pin_hash,pin_salt,training,construction,general,nickname,avatar_url`
  );
  if (!row) return { ok: false, error: "not_registered" };
  const computed = await sha256Hex((pin as string) + row.pin_salt);
  if (computed !== row.pin_hash) return { ok: false, error: "invalid_pin" };
  return {
    ok: true,
    record: {
      kingshot_id: kingshotId,
      nickname: row.nickname,
      avatar_url: row.avatar_url,
      training: row.training,
      construction: row.construction,
      general: row.general,
    },
  };
}

/**
 * update — token 우선, 없으면 PIN+ID (백워드 호환).
 * 인증 통과 시 kingshot_id 를 알아내고, 그 행에 새 값을 PATCH.
 */
async function updateRow(
  opts: { token?: unknown; kingshotId?: unknown; pin?: unknown },
  training: unknown,
  construction: unknown,
  general: unknown,
  meta: { ip: string | null; country: string | null; platform: string | null },
) {
  if (isPastDeadline()) return { ok: false, error: "past_deadline" };
  if (!isNonNegInt(training) || !isNonNegInt(construction) || !isNonNegInt(general)) {
    return { ok: false, error: "invalid_amount" };
  }
  const auth = await authenticate(opts);
  if (!auth.ok) return auth;
  // 닉네임/아바타/city_level + v2 확장 필드 동기 — 게임 내 변경 시 자동 반영.
  // v2 호출 (v1: fetchPlayerInfo 는 코드 유지)
  const player = await fetchPlayerInfoV2(auth.kingshotId);
  if (!player) return { ok: false, error: "player_not_found" };
  // 서버측 게이트 — 강등된 사용자가 update 로 데이터 갱신하는 것 차단.
  if (player.city_level === null || player.city_level < MIN_CITY_LEVEL) {
    return { ok: false, error: "city_level_too_low", city_level: player.city_level };
  }
  const patch: Record<string, unknown> = {
    nickname:                player.nickname,
    avatar_url:              player.avatar_image,
    city_level:              player.city_level,
    training:                training as number,
    construction:            construction as number,
    general:                 general as number,
    ip:                      meta.ip,
    country:                 meta.country,
    platform:                meta.platform,
    updated_at:              new Date().toISOString(),
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
  };
  await dbPatch(`kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(auth.kingshotId)}`, patch);
  return { ok: true };
}

/** delete — token 우선, 없으면 PIN+ID (백워드 호환).
 *  DB row 삭제 + Storage 의 인증샷도 함께 삭제 (service_role 로) → 고아 발생 차단. */
async function deleteRow(opts: { token?: unknown; kingshotId?: unknown; pin?: unknown }) {
  const auth = await authenticate(opts);
  if (!auth.ok) return auth;
  // Storage 먼저 — DB row 가 사라진 뒤 Storage 실패하면 추적 단서 없음.
  // 반대로 Storage 성공/DB 실패는 다음 register 시 동일 path upsert 로 자연 복구.
  await deleteEvidenceObject(auth.kingshotId).catch((e) => {
    // 삭제 실패해도 row 는 진행. 운영 시 로그로 추적.
    console.error(`evidence delete failed for ${auth.kingshotId}:`, e);
  });
  await dbDelete(`kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(auth.kingshotId)}`);
  return { ok: true };
}

/**
 * 인증샷 업로드/삭제 후 클라가 호출 — evidence_uploaded_at 토글.
 *   has_evidence=true  → now() 저장
 *   has_evidence=false → NULL
 * Storage 파일 자체는 클라가 직접 upsert/delete (bucket 의 anon 정책 활용).
 * 본 함수는 DB 메타데이터만 동기화.
 */
async function setEvidence(opts: { token?: unknown }, hasEvidence: unknown) {
  if (isPastDeadline()) return { ok: false, error: "past_deadline" };
  if (typeof hasEvidence !== "boolean") return { ok: false, error: "invalid_payload" };
  const auth = await authenticate(opts);
  if (!auth.ok) return auth;
  const ts = hasEvidence ? new Date().toISOString() : null;
  await dbPatch(
    `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(auth.kingshotId)}`,
    { evidence_uploaded_at: ts },
  );
  return { ok: true, evidence_uploaded_at: ts };
}

/**
 * 제출 현황 목록 — 인증 토큰 필수 (defense in depth).
 * 클라이언트 측에서도 isUnlocked()=!!getAuth() 가드가 있지만, anon key 로 직접 호출 시
 * 명단/가속권 데이터 노출 방지를 위해 서버 게이트 추가. 토큰 만료/무효 → 'unauthorized'.
 *
 * city_level >= 26 인 row 만 노출. NULL (기존 등록자) 도 자동 제외 — gte 가 NULL 매치 안 함.
 * 사용자는 [등록/수정] 재진행으로 city_level 채워지면 다시 표시됨.
 */
async function list(token: unknown) {
  if (!isValidToken(token)) return { ok: false, error: "unauthorized" };
  const me = await dbSelectOne(
    `kvk_speedup_survey?session_token=eq.${encodeURIComponent(token as string)}&select=session_expires_at`,
  );
  if (!me) return { ok: false, error: "unauthorized" };
  if (isTokenExpired(me.session_expires_at)) return { ok: false, error: "token_expired" };

  const rows = await dbSelect(
    `kvk_speedup_survey?select=kingshot_id,nickname,avatar_url,training,construction,general,city_level,evidence_uploaded_at,updated_at&city_level=gte.${MIN_CITY_LEVEL}&order=updated_at.desc`
  );
  return { ok: true, items: rows };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();
    const {
      action,
      kingshot_id,
      pin,
      token,
      training,
      construction,
      general,
      has_evidence,
    } = body ?? {};
    // IP / country 는 헤더에서만 추출 — 클라이언트 페이로드는 신뢰하지 않음
    const meta = extractRequestMeta(req);
    let result;
    switch (action) {
      case "lookup":
        result = await lookup(kingshot_id);
        break;
      case "login":
        result = await login(kingshot_id, pin);
        break;
      case "verify-token":
        result = await verifyToken(token);
        break;
      case "logout":
        result = await logout(token);
        break;
      case "register":
        result = await register(
          kingshot_id,
          pin,
          training,
          construction,
          general,
          meta,
        );
        break;
      case "verify":
        // deprecated — 백워드 호환용으로 유지. 신규 클라이언트는 login 사용.
        result = await verifyPin(kingshot_id, pin);
        break;
      case "update":
        result = await updateRow(
          { token, kingshotId: kingshot_id, pin },
          training,
          construction,
          general,
          meta,
        );
        break;
      case "set-evidence":
        result = await setEvidence({ token }, has_evidence);
        break;
      case "delete":
        result = await deleteRow({ token, kingshotId: kingshot_id, pin });
        break;
      case "list":
        result = await list(token);
        break;
      default:
        result = { ok: false, error: "unknown_action" };
    }
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
