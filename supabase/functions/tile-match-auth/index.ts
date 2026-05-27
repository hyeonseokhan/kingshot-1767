/**
 * tile-match-auth Edge Function
 *
 * 미니게임 본인 인증용 4자리 PIN 의 등록/검증.
 * member_credentials 테이블은 anon select 차단 → 이 함수만 (service_role) 접근.
 *
 * 액션:
 *   { action: "pin-status",  player_id }       → { ok, nickname, registered }
 *   { action: "set-pin",     player_id, pin }  → { ok } | { ok:false, error }
 *   { action: "verify-pin",  player_id, pin }  → { ok } | { ok:false, error }
 *
 * pin: 정확히 4자리 숫자 문자열 ("0000"~"9999").
 * hash: SHA-256(pin + per-user salt). salt 는 등록 시 랜덤 16바이트 hex.
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const dbHeaders: Record<string, string> = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function dbSelectOne(path: string): Promise<any | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { ...dbHeaders, Accept: "application/vnd.pgrst.object+json" },
  });
  if (res.status === 406) return null; // no row
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

function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}

async function pinStatus(playerId: string) {
  const member = await dbSelectOne(
    `members?kingshot_id=eq.${encodeURIComponent(playerId)}&select=kingshot_id,nickname,is_admin`
  );
  if (!member) return { ok: false, error: "member_not_found" };
  const cred = await dbSelectOne(
    `member_credentials?player_id=eq.${encodeURIComponent(playerId)}&select=player_id`
  );
  return { ok: true, nickname: member.nickname, registered: !!cred, is_admin: !!member.is_admin };
}

async function setPin(playerId: string, pin: unknown) {
  if (!isValidPin(pin)) return { ok: false, error: "invalid_pin" };
  const member = await dbSelectOne(
    `members?kingshot_id=eq.${encodeURIComponent(playerId)}&select=kingshot_id,is_admin`
  );
  if (!member) return { ok: false, error: "member_not_found" };
  const existing = await dbSelectOne(
    `member_credentials?player_id=eq.${encodeURIComponent(playerId)}&select=player_id`
  );
  if (existing) return { ok: false, error: "already_registered" };
  const salt = randomSaltHex();
  const hash = await sha256Hex(pin + salt);
  await dbInsert("member_credentials", { player_id: playerId, pin_hash: hash, pin_salt: salt });
  return { ok: true, is_admin: !!member.is_admin };
}

async function verifyPin(playerId: string, pin: unknown) {
  if (!isValidPin(pin)) return { ok: false, error: "invalid_pin" };
  const cred = await dbSelectOne(
    `member_credentials?player_id=eq.${encodeURIComponent(playerId)}&select=pin_hash,pin_salt`
  );
  if (!cred) return { ok: false, error: "not_registered" };
  const computed = await sha256Hex(pin + cred.pin_salt);
  if (computed !== cred.pin_hash) return { ok: false, error: "invalid_pin" };
  // 인증 성공 → admin 플래그 같이 반환 (클라이언트 세션에 박제)
  const member = await dbSelectOne(
    `members?kingshot_id=eq.${encodeURIComponent(playerId)}&select=is_admin`
  );
  return { ok: true, is_admin: !!member?.is_admin };
}

async function getRecord(playerId: string) {
  const rec = await dbSelectOne(
    `tile_match_records?player_id=eq.${encodeURIComponent(playerId)}&select=best_stage,total_clears,best_stage_at`
  );
  return {
    ok: true,
    best_stage: rec?.best_stage ?? 0,
    total_clears: rec?.total_clears ?? 0,
    best_stage_at: rec?.best_stage_at ?? null,
  };
}

async function recordClear(playerId: string, stage: unknown) {
  if (!Number.isInteger(stage as number) || (stage as number) < 1) {
    return { ok: false, error: "invalid_stage" };
  }
  const stageNum = stage as number;
  const member = await dbSelectOne(
    `members?kingshot_id=eq.${encodeURIComponent(playerId)}&select=kingshot_id`
  );
  if (!member) return { ok: false, error: "member_not_found" };

  const existing = await dbSelectOne(
    `tile_match_records?player_id=eq.${encodeURIComponent(playerId)}&select=best_stage,total_clears`
  );
  const now = new Date().toISOString();
  if (existing) {
    const newBest = Math.max(existing.best_stage, stageNum);
    const update: Record<string, unknown> = {
      best_stage: newBest,
      total_clears: existing.total_clears + 1,
      updated_at: now,
    };
    if (newBest > existing.best_stage) update.best_stage_at = now;
    await dbPatch(`tile_match_records?player_id=eq.${encodeURIComponent(playerId)}`, update);
    return { ok: true, best_stage: newBest, total_clears: existing.total_clears + 1, new_record: newBest > existing.best_stage };
  } else {
    await dbInsert("tile_match_records", {
      player_id: playerId,
      best_stage: stageNum,
      total_clears: 1,
      best_stage_at: now,
    });
    return { ok: true, best_stage: stageNum, total_clears: 1, new_record: true };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();
    const { action, player_id, pin } = body ?? {};
    if (!player_id || typeof player_id !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "missing_player_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    let result;
    switch (action) {
      case "pin-status":   result = await pinStatus(player_id); break;
      case "set-pin":      result = await setPin(player_id, pin); break;
      case "verify-pin":   result = await verifyPin(player_id, pin); break;
      case "get-record":   result = await getRecord(player_id); break;
      case "record-clear": result = await recordClear(player_id, body.stage); break;
      default:             result = { ok: false, error: "unknown_action" };
    }
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
