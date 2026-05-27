-- KvK 버프 예약 — [재시작] RPC 가 finalized_at 도 초기화하도록 보완.
--
-- 배경:
--   20260515000600 의 kvk_buff_reset_test 함수는 finalized_at 컬럼이 추가되기 전(20260515000800)
--   에 작성되어, [재시작] 호출 시 participants/turn 만 비워지고 state.finalized_at 는 그대로 남음.
--   → 마감 상태 유지되어 "재시작 후에도 마감 메시지 + grid 비활성" 회귀.
--
-- ROLLBACK:
--   -- 20260515000600 의 원본 정의로 회귀 (finalized_at 누락).

CREATE OR REPLACE FUNCTION kvk_buff_reset_test()
RETURNS VOID AS $$
BEGIN
  TRUNCATE TABLE kvk_buff_participants_test;
  UPDATE kvk_buff_state_test SET
    bootstrapped_at = NULL,
    current_turn_idx = 0,
    turn_started_at = NULL,
    finalized_at = NULL,
    updated_at = now()
  WHERE id = 1;
END;
$$ LANGUAGE plpgsql;
