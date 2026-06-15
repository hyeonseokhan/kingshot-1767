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

const KS_API_BASE   = "https://kingshot-giftcode.centurygame.com/api";
const KS_API_SECRET = "mN4!pQs6JrYwV9";

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

      const gamePlayer = await fetchGamePlayer(player_id as string);
      if (!gamePlayer) return json({ ok: false, error: "player_not_found" });

      const survey = await dbSelectOne(
        `kvk_speedup_survey?kingshot_id=eq.${encodeURIComponent(player_id as string)}&select=city_level`,
      );

      return json({
        ok: true,
        nickname:   gamePlayer.nickname,
        avatar_url: gamePlayer.avatar_url,
        city_level: survey?.city_level ?? null,
      });
    }

    // ── upsert-position ────────────────────────────────────
    if (action === "upsert-position") {
      const { token, id, kingshot_id, nickname, avatar_url, city_level } = body;
      if (typeof id !== "number") return json({ ok: false, error: "invalid_id" });

      await requireStrategyAdmin(token);

      await dbPatch(`strategy_assignments?id=eq.${id}`, {
        kingshot_id: kingshot_id ?? null,
        nickname:    nickname    ?? null,
        avatar_url:  avatar_url  ?? null,
        city_level:  city_level  ?? null,
      });

      return json({ ok: true });
    }

    // ── clear-position ─────────────────────────────────────
    if (action === "clear-position") {
      const { token, id } = body;
      if (typeof id !== "number") return json({ ok: false, error: "invalid_id" });

      await requireStrategyAdmin(token);

      await dbPatch(`strategy_assignments?id=eq.${id}`, {
        kingshot_id: null,
        nickname:    null,
        avatar_url:  null,
        city_level:  null,
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
        `strategy_assignments?id=in.(${id_a},${id_b})&select=id,kingshot_id,nickname,avatar_url,city_level`,
      );
      if (rows.length !== 2) return json({ ok: false, error: "position_not_found" });

      const a = rows.find((r: any) => r.id === id_a)!;
      const b = rows.find((r: any) => r.id === id_b)!;

      await dbPatch(`strategy_assignments?id=eq.${id_a}`, {
        kingshot_id: b.kingshot_id,
        nickname:    b.nickname,
        avatar_url:  b.avatar_url,
        city_level:  b.city_level,
      });
      await dbPatch(`strategy_assignments?id=eq.${id_b}`, {
        kingshot_id: a.kingshot_id,
        nickname:    a.nickname,
        avatar_url:  a.avatar_url,
        city_level:  a.city_level,
      });

      return json({ ok: true });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    const KNOWN = new Set(["invalid_token", "not_admin", "position_not_found", "same_position"]);
    if (KNOWN.has(msg)) return json({ ok: false, error: msg });
    console.error(`[strategy] unexpected error action=${action}`, err);
    return json({ ok: false, error: "unexpected_error" }, 500);
  }
});
