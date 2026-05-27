-- KvK 계산기 (1회성 도구) 제거. /game-tools/kvk-calculator/ 페이지와 함께
-- 클라이언트 코드 / i18n / CSS 모두 동일 commit 에서 삭제.
--
-- kvk_calculator_state 테이블에는 단일 사용자 (270680423) 의 입력 snapshot 만 들어있었음.
-- 의존 객체:
--   - PRIMARY KEY → members(kingshot_id) 의 FK 는 CASCADE 만 받음 (역방향 의존 없음)
--   - 트리거 kvk_calculator_state_updated_at — 본 DROP TABLE 에 자동 따라옴
--   - 정책 4종 (kvk_calculator_state_{select,insert,update,delete}) — DROP TABLE 시 자동 정리
--   - update_updated_at() 함수 — 다른 테이블도 공유하므로 보존
--
-- ROLLBACK:
--   20260521000000_create_kvk_calculator_state.sql 의 CREATE TABLE / TRIGGER /
--   POLICY 블록을 그대로 다시 실행하면 복원 가능 (기존 row 는 복구 불가).

DROP TABLE IF EXISTS kvk_calculator_state;
