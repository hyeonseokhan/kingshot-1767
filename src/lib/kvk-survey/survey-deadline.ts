/**
 * KvK 설문 등록 마감 시각 — 클라 single source of truth.
 *
 * 사용 위치:
 *   - src/scripts/pages/survey-kvk.ts (등록/수정 카운트다운, 버튼 노출 분기)
 *   - src/scripts/pages/survey-kvk-buff.ts (버프 예약 다이얼로그)
 *
 * 서버 mirror (수동 동기화 필수):
 *   - supabase/functions/kvk-buff/index.ts:DEADLINE_ISO
 *   변경 시 두 곳 동시 수정. drift 시 회귀:
 *     클라 < 서버 → 클라가 [버프 예약] 노출하지만 서버 bootstrap 거부 → 잠금 placeholder
 *     클라 > 서버 → 클라가 [등록/수정] 노출하지만 서버는 마감 후 (현재 register API 는 deadline 미검증)
 *
 * 관련 i18n: '안내문 — 마감: UTC 5월 16일 01:00' 도 같이 변경 필요 (ko/en).
 */
export const SURVEY_DEADLINE_ISO = '2026-05-16T01:00:00Z';
