-- 2회차 KvK 가속권 설문 초기화 — 1회차 응답/예약 데이터 전량 정리.
--
-- 배경:
--   kvk_speedup_survey 에는 '회차(round/season)' 컬럼이 없음 — 사용자당 1행 구조.
--   따라서 2회차 시작 = 1회차 데이터 전량 삭제 후 재수집.
--   마감 시각은 코드에서 2026-06-14T00:00:00Z (KST 6/14 09:00) 로 변경됨
--   (src/lib/kvk-survey/survey-deadline.ts + supabase/functions/kvk-buff/index.ts).
--
-- 정리 대상:
--   1) kvk_speedup_survey       — 설문 응답 전량 (PIN/세션/가속권/인증메타 포함)
--   2) kvk_buff_participants    — 1회차 버프 예약 48명
--   3) kvk_buff_state           — bootstrap/턴 상태 리셋
--
-- !!! 주의 — 본 SQL 만으로 끝나지 않는 후속 작업 (사용자 직접):
--   * admin 6명: kvk_speedup_survey TRUNCATE 로 is_admin 플래그도 사라짐.
--     2회차에 해당 6명이 재등록한 뒤 UPDATE ... SET is_admin = TRUE 로 재부여 필요.
--   * Storage 인증샷: survey-evidence 버킷의 1회차 *.webp 는 SQL 로 삭제 불가.
--     scripts/reset-survey-evidence-round2.* (별도) 로 일괄 삭제.
--
-- 본 SQL 은 idempotent — 이미 비어있어도 안전.
--
-- ROLLBACK: 없음 (데이터 삭제는 비가역). 1회차 데이터가 필요하면 적용 전 백업 필수.

-- CASCADE: kvk_buff_participants.kingshot_id 가 ON DELETE CASCADE 로 본 테이블을 FK 참조.
-- TRUNCATE CASCADE 가 participants 도 함께 비움 (아래 명시 TRUNCATE 는 idempotent 안전장치).
TRUNCATE TABLE kvk_speedup_survey CASCADE;

TRUNCATE TABLE kvk_buff_participants;

UPDATE kvk_buff_state
SET bootstrapped_at = NULL,
    current_turn_idx = 0,
    turn_started_at = NULL,
    finalized_at = NULL,
    updated_at = now()
WHERE id = 1;
