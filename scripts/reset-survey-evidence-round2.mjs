/**
 * 2회차 초기화 보조 — survey-evidence 버킷의 1회차 인증샷(*.webp) 일괄 삭제.
 *
 * 왜 필요한가:
 *   DB 마이그레이션(20260613000000_reset_kvk_survey_round2.sql)이 kvk_speedup_survey 를
 *   TRUNCATE 하면 row 의 evidence_uploaded_at 은 사라지지만, Storage 의 실제 파일
 *   (survey-evidence/{kingshot_id}.webp) 은 고아로 남는다. 본 스크립트가 그 파일들을 정리.
 *
 * 권한:
 *   Storage 객체 삭제는 service_role 키 필요. .env 의 anon 키로는 불가.
 *   → 실행 시 SUPABASE_SERVICE_ROLE_KEY 를 env 로 직접 주입 (커밋 금지).
 *
 * 실행:
 *   PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/reset-survey-evidence-round2.mjs
 *   (--dry-run 플래그로 삭제 대상만 출력하고 실제 삭제는 건너뜀)
 *
 * 안전장치:
 *   * survey-evidence 버킷만 대상 (다른 버킷 손대지 않음).
 *   * 삭제 전 대상 목록 출력 → 개수 확인 가능.
 *   * --dry-run 으로 먼저 확인 권장.
 */

const BUCKET = 'survey-evidence';
const DRY_RUN = process.argv.includes('--dry-run');

const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  console.error('환경변수 PUBLIC_SUPABASE_URL (또는 SUPABASE_URL) 가 필요합니다.');
  process.exit(1);
}
if (!SERVICE_KEY) {
  console.error('환경변수 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다 (Storage 삭제 권한).');
  process.exit(1);
}

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

/** 버킷 루트의 객체 목록 (최대 1000개씩 페이지네이션). */
async function listObjects() {
  const all = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prefix: '', limit, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!res.ok) throw new Error(`list ${res.status}: ${await res.text()}`);
    const page = await res.json();
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  // 폴더 placeholder (id == null) 제외, 실제 파일만
  return all.filter((o) => o.id != null).map((o) => o.name);
}

async function removeObjects(names) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ prefixes: names }),
  });
  if (!res.ok) throw new Error(`delete ${res.status}: ${await res.text()}`);
  return res.json();
}

(async () => {
  console.log(`[reset-evidence] 버킷 = ${BUCKET}${DRY_RUN ? ' (DRY RUN)' : ''}`);
  const names = await listObjects();
  console.log(`[reset-evidence] 삭제 대상 ${names.length} 개`);
  if (names.length === 0) {
    console.log('[reset-evidence] 비어있음 — 작업 없음.');
    return;
  }
  for (const n of names) console.log('  -', n);

  if (DRY_RUN) {
    console.log('[reset-evidence] --dry-run 이라 실제 삭제 안 함.');
    return;
  }

  // Storage delete API 는 한 번에 다수 prefix 허용 — 1000개씩 끊어 호출.
  const CHUNK = 1000;
  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK);
    await removeObjects(chunk);
    console.log(`[reset-evidence] ${Math.min(i + CHUNK, names.length)}/${names.length} 삭제 완료`);
  }
  console.log('[reset-evidence] 완료.');
})().catch((e) => {
  console.error('[reset-evidence] 실패:', e.message);
  process.exit(1);
});
