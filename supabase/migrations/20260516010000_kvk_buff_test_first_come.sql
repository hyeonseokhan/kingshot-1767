-- !!! TEST_MODE — 선착순 모드 전환 (테스트 환경만) !!!
--
-- 기획 변경: 순차 지정 → 선착순 지정.
--   기존: state.current_turn_idx 의 사용자만 슬롯 픽 가능 (turn_idx 검사)
--   변경: 모든 미점유 사용자가 자유롭게 빈 슬롯 픽 (UNIQUE constraint 가 race 차단)
--
-- 변경 범위: kvk_buff_pick_slot_test 만. 운영 (kvk_buff_pick_slot) 은 기존 순차 그대로.
-- state.current_turn_idx / turn_started_at 컬럼은 그대로 유지 (의미 없어짐, 무시).
--
-- 호출 시그니처 변경: (TEXT, INT, INT) → (TEXT, INT). expected_turn_idx 제거.
-- 기존 함수는 DROP — 백워드 호환은 운영 RPC 가 담당.

DROP FUNCTION IF EXISTS kvk_buff_pick_slot_test(TEXT, INT, INT);

CREATE OR REPLACE FUNCTION kvk_buff_pick_slot_test(
  p_kingshot_id TEXT,
  p_slot_idx INT
) RETURNS VOID AS $$
DECLARE
  state_row RECORD;
  participant RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state_test WHERE id = 1 FOR UPDATE;
  IF state_row.bootstrapped_at IS NULL THEN
    RAISE EXCEPTION 'not_bootstrapped';
  END IF;
  IF state_row.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'finalized';
  END IF;

  SELECT * INTO participant FROM kvk_buff_participants_test
  WHERE kingshot_id = p_kingshot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_participant';
  END IF;
  IF participant.slot_idx IS NOT NULL THEN
    RAISE EXCEPTION 'already_picked';
  END IF;

  -- slot_idx UNIQUE (partial) 인덱스가 동일 슬롯 동시 점유 차단 → race 시 23505.
  -- 호출자가 'slot_taken' 으로 catch (Edge Function maskError 는 raw 23505 → unexpected_error).
  -- → INSERT...ON CONFLICT 대신 UPDATE 후 unique violation 잡아서 명시 에러.
  BEGIN
    UPDATE kvk_buff_participants_test
    SET slot_idx = p_slot_idx, picked_at = now()
    WHERE kingshot_id = p_kingshot_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'slot_taken';
  END;

  -- 선착순 모드: state.current_turn_idx 갱신 X (의미 없음). 진행률은 클라가 participants 카운트로.
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION kvk_buff_pick_slot_test(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvk_buff_pick_slot_test(TEXT, INT) TO service_role;

-- ROLLBACK:
--   DROP FUNCTION IF EXISTS kvk_buff_pick_slot_test(TEXT, INT);
--   -- 기존 시그니처 (TEXT, INT, INT) 복원하려면 20260515000300 의 정의 재실행.

-- ===== 추가: not_participant / 중복 키 =====
-- Edge Function 의 KNOWN_ERRORS 에 'not_participant' 추가 필요 (TS 코드).
