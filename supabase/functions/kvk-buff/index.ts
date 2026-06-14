/**
 * kvk-buff Edge Function — KvK 버프 예약 페이지의 백엔드.
 *
 * 액션:
 *   { action: 'get-state', token?, test_mode? }                                    → { ok, state, participants[], me? }
 *     bootstrap 안 됐고 마감 지났으면 자동 init.
 *     token 주면 me (현재 사용자 정보 + is_admin) 도 함께 응답.
 *   { action: 'pick-slot', token, slot_idx, expected_turn_idx, test_mode? }        → { ok }
 *   { action: 'admin-skip', token, expected_turn_idx, test_mode? }                 → { ok }   (DEPRECATED, 백워드 호환)
 *   { action: 'admin-replace-current', token, target_kingshot_id,
 *                                       expected_turn_idx, test_mode? }            → { ok }   (admin 만, 현재 차례 ↔ target turn_idx swap)
 *   { action: 'admin-swap', token, slot_a_idx, slot_b_idx, test_mode? }            → { ok }
 *   { action: 'admin-start', token, test_mode? }                                    → { ok }   (admin 만, bootstrap RPC 호출 → 48명 INSERT)
 *   { action: 'finalize', token, test_mode? }                                       → { ok }   (admin 만, state.finalized_at = now)
 *   { action: 'admin-reset-test', token, test_mode: true }                         → { ok }   (TEST_MODE 전용 [재시작])
 *
 * 권한: token 으로 kingshot_id 추출. admin 액션은 is_admin=TRUE 검증.
 *
 * 5초 polling: 모든 클라가 5초마다 get-state 호출. 응답으로 local 상태 갱신.
 *
 * 동시성: 모든 변경은 plpgsql RPC 안에서 SELECT ... FOR UPDATE + 단일 UPDATE statement 로 atomic.
 *         RPC 가 stale 감지 시 'turn_changed' 에러 → 클라가 즉시 새 state fetch + 새로고침.
 *
 * !!! TEST_MODE — 관리자 필드 테스트 종료 후 제거 대상 !!!
 *   body.test_mode === true → kvk_buff_*_test 테이블 + _test RPC 사용.
 *   격리 범위: buff 테이블만. 인증/회원 (kvk_speedup_survey) 은 운영 그대로 공유.
 *   bootstrap_test 는 deadline 검증 skip (테스트는 즉시 시작 가능).
 *   제거: `TEST_MODE` 키워드 grep + isTest 분기 코드 일괄 제거 + 마이그레이션 ROLLBACK 적용.
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
  if (res.status === 406) return null;
  if (!res.ok) throw new Error(`db select ${res.status}: ${await res.text()}`);
  return res.json();
}

async function dbSelect(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: dbHeaders });
  if (!res.ok) throw new Error(`db select ${res.status}: ${await res.text()}`);
  return res.json();
}

/** RPC 호출 — error 메시지의 EXCEPTION 메시지를 그대로 throw 해서 클라이언트가 에러 코드로 활용. */
async function dbRpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: dbHeaders,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // PostgREST RPC 에러 형식: { code, details, hint, message }
    try {
      const json = JSON.parse(text);
      throw new Error(json.message ?? text);
    } catch {
      throw new Error(text || `rpc ${name} ${res.status}`);
    }
  }
  return text ? JSON.parse(text) : null;
}

function isValidToken(t: unknown): t is string {
  return typeof t === "string" && /^[0-9a-f-]{36}$/i.test(t);
}

/** RPC / 내부 로직이 raise 한 알려진 에러 코드 — 그대로 클라 i18n 키로 forward 안전.
 *  그 외 메시지(특히 PostgreSQL raw 에러 JSON)는 'unexpected_error' 로 단일화 + Function logs 기록. */
const KNOWN_ERRORS = new Set([
  // pick_slot / state
  "turn_changed", "already_picked", "slot_taken", "not_your_turn",
  "all_picked", "not_bootstrapped", "before_deadline", "not_participant",
  // admin
  "not_admin", "slot_not_occupied", "no_next", "same_slot",
  "no_current_holder", "same_target", "target_not_found", "target_already_picked",
  // finalize
  "finalized", "already_finalized",
  // admin-add (마감 후 수동 추가)
  "not_in_survey", "already_participant",
  // 인증/검증
  "invalid_token", "token_expired",
  "invalid_id", "invalid_slot_idx", "invalid_turn_idx", "missing_auth",
  // TEST_MODE
  "test_mode_only",
]);

/** RPC catch 블록 공통 — 알려진 에러만 forward, 그 외는 'unexpected_error' 로 마스킹.
 *  raw 메시지는 Supabase Function logs (console.error) 에 기록 → Dashboard 에서 검색. */
function maskError(err: unknown, ctx: { action: string; kingshotId?: string | null }): {
  ok: false;
  error: string;
} {
  const raw = String((err as Error)?.message ?? err);
  if (KNOWN_ERRORS.has(raw)) {
    return { ok: false, error: raw };
  }
  console.error(
    `[kvk-buff] unexpected error action=${ctx.action} kingshot_id=${ctx.kingshotId ?? "-"} message=${raw}`,
  );
  return { ok: false, error: "unexpected_error" };
}

function isValidSlotIdx(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 48;
}

function isValidTurnIdx(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 48;
}

interface Me {
  kingshot_id: string;
  nickname: string;
  is_admin: boolean;
}

/** token → kvk_speedup_survey 의 사용자 정보 + is_admin. 만료 검증.
 *  TEST_MODE 와 무관 — 인증/회원은 운영 테이블 그대로 사용. */
async function authenticate(
  token: unknown,
): Promise<{ ok: true; me: Me } | { ok: false; error: string }> {
  if (!isValidToken(token)) return { ok: false, error: "invalid_token" };
  const row = await dbSelectOne(
    `kvk_speedup_survey?session_token=eq.${encodeURIComponent(token)}` +
      `&select=kingshot_id,nickname,is_admin,session_expires_at`,
  );
  if (!row) return { ok: false, error: "invalid_token" };
  if (!row.session_expires_at || new Date(row.session_expires_at) <= new Date()) {
    return { ok: false, error: "token_expired" };
  }
  return {
    ok: true,
    me: {
      kingshot_id: row.kingshot_id,
      nickname: row.nickname,
      is_admin: row.is_admin === true,
    },
  };
}

/**
 * 마감 시각 — 클라 (src/lib/survey-deadline.ts) 와 수동 동기화 필수.
 *
 * 변경 절차 (drift 회귀 방지):
 *   1) src/lib/survey-deadline.ts 의 SURVEY_DEADLINE_ISO 변경
 *   2) 본 DEADLINE_ISO 도 같은 값으로 변경
 *   3) i18n 의 마감 안내문 (ko/en) 도 같이 갱신
 *   4) Edge Function 재배포 (supabase functions deploy kvk-buff)
 *
 * 어긋날 때:
 *   클라 < 서버 → 클라 [버프 예약] 노출되지만 서버 bootstrap 거부 → 잠금 placeholder 표시
 *   클라 > 서버 → 클라 [등록/수정] 노출되지만 서버는 마감 후 (현재 register API 는 deadline 미검증)
 */
const DEADLINE_ISO = "2026-06-14T00:00:00Z";

// !!! TEST_MODE 분기 helper — 테스트 종료 후 제거 대상 !!!
//   isTest=true 면 _test 테이블/RPC 이름 반환.
const t = (name: string, isTest: boolean) => `${name}${isTest ? "_test" : ""}`;

async function getState(token: unknown, isTest: boolean) {
  // bootstrap 은 admin 의 [예약 시작] 액션 (admin-start) 으로만 트리거 — lazy bootstrap 제거.
  // (이전엔 deadline 통과 시 자동. 새 기획: admin 명시 시작.)

  // state + participants 조회 (참가자엔 닉네임/avatar 도 join 필요)
  const state = await dbSelectOne(
    `${t("kvk_buff_state", isTest)}?id=eq.1&select=bootstrapped_at,current_turn_idx,turn_started_at,finalized_at,updated_at`,
  );
  // PostgREST embedded resource — kvk_speedup_survey 와 join (FK 자동 활용)
  // _test 의 FK 도 운영 kvk_speedup_survey 참조 → 같은 embedded 패턴 동작.
  const participants = await dbSelect(
    `${t("kvk_buff_participants", isTest)}?select=kingshot_id,turn_idx,score_rank,was_verified,slot_idx,picked_at,survey:kvk_speedup_survey(nickname,avatar_url,city_level)` +
      `&order=turn_idx.asc`,
  );

  // 3. me (token 있으면)
  let me: (Me & { turn_idx?: number; slot_idx?: number | null }) | null = null;
  if (token !== undefined && token !== null) {
    const auth = await authenticate(token);
    if (auth.ok) {
      const myRow = participants.find((p: any) => p.kingshot_id === auth.me.kingshot_id);
      me = {
        ...auth.me,
        turn_idx: myRow?.turn_idx,
        slot_idx: myRow?.slot_idx ?? null,
      };
    }
  }

  return {
    ok: true,
    deadline: DEADLINE_ISO,
    state,
    participants,
    me,
  };
}

async function pickSlot(token: unknown, slotIdx: unknown, _expectedTurnIdx: unknown, isTest: boolean) {
  // 운영/테스트 모두 선착순. expected_turn_idx 무관 (백워드 호환 위해 인자 자리만 유지, 무시).
  if (!isValidSlotIdx(slotIdx)) return { ok: false, error: "invalid_slot_idx" };
  const auth = await authenticate(token);
  if (!auth.ok) return auth;
  try {
    // kvk_buff_pick_slot 은 TEXT 반환 ('ok' | 'slot_taken').
    // 트리거 발화(A/B 동적 등록) 시 INSERT 를 커밋한 뒤 'slot_taken' 을 반환.
    // RAISE EXCEPTION 으로 반환하면 INSERT 도 롤백되므로 RETURN TEXT 로 변경됨.
    const result = await dbRpc(t("kvk_buff_pick_slot", isTest), {
      p_kingshot_id: auth.me.kingshot_id,
      p_slot_idx: slotIdx,
    }) as string | null;
    if (result === "slot_taken") return { ok: false, error: "slot_taken" };
    return { ok: true };
  } catch (e) {
    return maskError(e, { action: "pick-slot", kingshotId: auth.me.kingshot_id });
  }
}

async function adminSkip(token: unknown, expectedTurnIdx: unknown, isTest: boolean) {
  // DEPRECATED — UI 는 [변경] 액션 사용 (admin-replace-current). 백워드 호환 위해 유지.
  if (!isValidTurnIdx(expectedTurnIdx)) return { ok: false, error: "invalid_turn_idx" };
  const auth = await authenticate(token);
  if (!auth.ok) return auth;
  if (!auth.me.is_admin) return { ok: false, error: "not_admin" };
  try {
    await dbRpc(t("kvk_buff_admin_skip", isTest), { p_expected_turn_idx: expectedTurnIdx });
    return { ok: true };
  } catch (e) {
    return maskError(e, { action: "admin-skip", kingshotId: auth.me.kingshot_id });
  }
}

/** [변경] — 현재 차례 사용자 turn_idx 와 임의 미완료 사용자 turn_idx 를 swap.
 *  결과: target 즉시 차례. 이전 차례 사용자는 target 의 원래 자리로 밀려남. */
async function adminReplaceCurrent(
  token: unknown,
  targetKingshotId: unknown,
  expectedTurnIdx: unknown,
  isTest: boolean,
) {
  if (typeof targetKingshotId !== "string" || !targetKingshotId) {
    return { ok: false, error: "missing_auth" };
  }
  if (!isValidTurnIdx(expectedTurnIdx)) return { ok: false, error: "invalid_turn_idx" };
  const auth = await authenticate(token);
  if (!auth.ok) return auth;
  if (!auth.me.is_admin) return { ok: false, error: "not_admin" };
  try {
    await dbRpc(t("kvk_buff_admin_replace_current", isTest), {
      p_target_kingshot_id: targetKingshotId,
      p_expected_turn_idx: expectedTurnIdx,
    });
    return { ok: true };
  } catch (e) {
    return maskError(e, { action: "admin-replace-current", kingshotId: auth.me.kingshot_id });
  }
}

async function adminSwap(token: unknown, slotA: unknown, slotB: unknown, isTest: boolean) {
  if (!isValidSlotIdx(slotA) || !isValidSlotIdx(slotB)) {
    return { ok: false, error: "invalid_slot_idx" };
  }
  if (slotA === slotB) return { ok: false, error: "same_slot" };
  const auth = await authenticate(token);
  if (!auth.ok) return auth;
  if (!auth.me.is_admin) return { ok: false, error: "not_admin" };
  try {
    await dbRpc(t("kvk_buff_admin_swap", isTest), {
      p_slot_a_idx: slotA,
      p_slot_b_idx: slotB,
    });
    return { ok: true };
  } catch (e) {
    return maskError(e, { action: "admin-swap", kingshotId: auth.me.kingshot_id });
  }
}

/** 예약 마감 — admin only. 호출 시 state.finalized_at = now() 로 모든 mutation 차단. */
async function finalize(token: unknown, isTest: boolean) {
  const auth = await authenticate(token);
  if (!auth.ok) return auth;
  if (!auth.me.is_admin) return { ok: false, error: "not_admin" };
  try {
    await dbRpc(t("kvk_buff_finalize", isTest), {});
    return { ok: true };
  } catch (e) {
    return maskError(e, { action: "finalize", kingshotId: auth.me.kingshot_id });
  }
}

/** [예약 시작] — admin 만 호출. bootstrap RPC 호출 → 48명 INSERT + state.bootstrapped_at 갱신.
 *  운영/테스트 동일 액션. testMode 면 _test RPC. */
async function adminStart(token: unknown, isTest: boolean) {
  const auth = await authenticate(token);
  if (!auth.ok) return auth;
  if (!auth.me.is_admin) return { ok: false, error: "not_admin" };
  try {
    await dbRpc(t("kvk_buff_bootstrap", isTest), {});
    return { ok: true };
  } catch (e) {
    return maskError(e, { action: "admin-start", kingshotId: auth.me.kingshot_id });
  }
}

/** [추가] — admin 만. 순위권 밖 인원을 빈 슬롯에 직접 등록 (마감 후에도 가능).
 *  설문 제출자(city_level>=26)만 허용 — RPC 가 not_in_survey 로 거부.
 *  RPC 반환 TEXT: 'ok' | 'slot_taken' (slot_taken 은 RETURN, 그 외 거부는 RAISE). */
async function adminAdd(token: unknown, targetKingshotId: unknown, slotIdx: unknown, isTest: boolean) {
  if (typeof targetKingshotId !== "string" || !/^\d{4,15}$/.test(targetKingshotId)) {
    return { ok: false, error: "invalid_id" };
  }
  if (!isValidSlotIdx(slotIdx)) return { ok: false, error: "invalid_slot_idx" };
  const auth = await authenticate(token);
  if (!auth.ok) return auth;
  if (!auth.me.is_admin) return { ok: false, error: "not_admin" };
  try {
    const result = await dbRpc(t("kvk_buff_admin_add", isTest), {
      p_kingshot_id: targetKingshotId,
      p_slot_idx: slotIdx,
    }) as string | null;
    if (result === "slot_taken") return { ok: false, error: "slot_taken" };
    return { ok: true };
  } catch (e) {
    return maskError(e, { action: "admin-add", kingshotId: auth.me.kingshot_id });
  }
}

/** !!! TEST_MODE 전용 — admin 만 호출. _test 참가자 전체 + state 초기화. !!!
 *  운영(isTest=false) 호출은 reject. 다음 get-state 가 lazy bootstrap 으로 admin 6명 다시 INSERT. */
async function adminResetTest(token: unknown, isTest: boolean) {
  if (!isTest) return { ok: false, error: "test_mode_only" };
  const auth = await authenticate(token);
  if (!auth.ok) return auth;
  if (!auth.me.is_admin) return { ok: false, error: "not_admin" };
  try {
    await dbRpc("kvk_buff_reset_test", {});
    return { ok: true };
  } catch (e) {
    return maskError(e, { action: "admin-reset-test", kingshotId: auth.me.kingshot_id });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();
    const { action, token, slot_idx, expected_turn_idx, slot_a_idx, slot_b_idx, target_kingshot_id } = body ?? {};
    // !!! TEST_MODE — 클라가 ?test=1 일 때만 true. default false (운영). !!!
    const isTest = body?.test_mode === true;
    let result;
    switch (action) {
      case "get-state":
        result = await getState(token, isTest);
        break;
      case "pick-slot":
        result = await pickSlot(token, slot_idx, expected_turn_idx, isTest);
        break;
      case "admin-skip":
        // DEPRECATED — UI 에선 admin-replace-current 사용. 본 액션은 백워드 호환 유지용.
        result = await adminSkip(token, expected_turn_idx, isTest);
        break;
      case "admin-swap":
        result = await adminSwap(token, slot_a_idx, slot_b_idx, isTest);
        break;
      case "admin-replace-current":
        result = await adminReplaceCurrent(token, target_kingshot_id, expected_turn_idx, isTest);
        break;
      case "finalize":
        result = await finalize(token, isTest);
        break;
      case "admin-start":
        result = await adminStart(token, isTest);
        break;
      case "admin-add":
        result = await adminAdd(token, target_kingshot_id, slot_idx, isTest);
        break;
      case "admin-reset-test":
        result = await adminResetTest(token, isTest);
        break;
      default:
        result = { ok: false, error: "unknown_action" };
    }
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    // 최외곽 catch — JSON parse / 예측 못한 throw. raw 메시지는 logs 에만 남기고
    // 클라엔 일반 키만 (i18n fallback 으로 친화적 안내).
    console.error("[kvk-buff] outer error:", String((err as Error)?.message ?? err));
    return new Response(
      JSON.stringify({ ok: false, error: "unexpected_error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
