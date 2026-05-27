-- 운영 buff 데이터 정리 — 관리자 필드 테스트 종료 후 운영 시즌 정상 진행 가능 상태로 복귀.
--
-- 배경:
--   2026-05-13 ~ 2026-05-14 동안 SURVEY_DEADLINE_ISO 임시 단축 (2024-01-01) 으로 운영 DB 의
--   kvk_buff_state / kvk_buff_participants 에 테스트 데이터 누적됨. 운영 시즌 시작 시
--   bootstrap 이 비어있는 상태에서 시작해야 정상이라 일회성 정리.
--
--   본 마이그레이션 이후 운영 buff 흐름: 클라가 deadline (2026-05-16 01:00 UTC) 통과
--   직후 첫 get-state 호출 → lazy bootstrap 으로 정상 init.
--
-- 주의:
--   * is_admin = TRUE 6명 (Toycode/Raducanu/SsungBi/Pirate King/ISU/Joker_Ping) 은 그대로 유지.
--   * 본 SQL 은 idempotent — 이미 비어있어도 안전.

TRUNCATE TABLE kvk_buff_participants;
UPDATE kvk_buff_state
SET bootstrapped_at = NULL,
    current_turn_idx = 0,
    turn_started_at = NULL,
    updated_at = now()
WHERE id = 1;
