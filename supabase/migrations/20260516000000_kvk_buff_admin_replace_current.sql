-- KvK 버프 예약 — admin [변경] 액션용 RPC.
--
-- 동작:
--   현재 차례 (state.current_turn_idx) 사용자의 turn_idx 와 임의 미완료 사용자의 turn_idx 를 swap.
--   결과: target 이 즉시 차례를 받고, 이전 차례 사용자는 target 의 원래 자리로 밀려남.
--
-- 시나리오:
--   초기   A(0), B(1), C(2)   ▶ 차례 A
--   A 부재 → admin [변경] B 선택 → B(0), A(1), C(2)   ▶ 차례 B
--   B 완료 → 차례 A. A 또 부재 → [변경] C 선택 → B(0), C(1), A(2)
--
-- 검증:
--   - p_target_kingshot_id 가 미완료 (slot_idx IS NULL) 사용자
--   - 현재 차례 본인 X
--   - p_expected_turn_idx 가 state.current_turn_idx 와 일치 (stale 차단)
--
-- admin 검증은 Edge Function 레벨 (authenticate → me.is_admin).

-- ===== 운영 =====
CREATE OR REPLACE FUNCTION kvk_buff_admin_replace_current(
  p_target_kingshot_id TEXT,
  p_expected_turn_idx INT
) RETURNS VOID AS $$
DECLARE
  state_row RECORD;
  current_holder_id TEXT;
  target_row RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state WHERE id = 1 FOR UPDATE;
  IF state_row.current_turn_idx != p_expected_turn_idx THEN
    RAISE EXCEPTION 'turn_changed';
  END IF;

  -- 현재 차례 사용자
  SELECT kingshot_id INTO current_holder_id FROM kvk_buff_participants
  WHERE turn_idx = state_row.current_turn_idx;
  IF current_holder_id IS NULL THEN
    RAISE EXCEPTION 'no_current_holder';
  END IF;
  IF current_holder_id = p_target_kingshot_id THEN
    RAISE EXCEPTION 'same_target';
  END IF;

  -- target — 미완료 (slot_idx IS NULL) 검증
  SELECT * INTO target_row FROM kvk_buff_participants
  WHERE kingshot_id = p_target_kingshot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target_not_found';
  END IF;
  IF target_row.slot_idx IS NOT NULL THEN
    RAISE EXCEPTION 'target_already_picked';
  END IF;

  -- 두 사람 turn_idx swap (deferrable unique 라 single statement OK)
  UPDATE kvk_buff_participants
  SET turn_idx = CASE
    WHEN kingshot_id = current_holder_id THEN target_row.turn_idx
    WHEN kingshot_id = p_target_kingshot_id THEN state_row.current_turn_idx
  END
  WHERE kingshot_id IN (current_holder_id, p_target_kingshot_id);
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION kvk_buff_admin_replace_current(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvk_buff_admin_replace_current(TEXT, INT) TO service_role;

-- ===== TEST_MODE — 동일 로직, _test 테이블 사용 =====
CREATE OR REPLACE FUNCTION kvk_buff_admin_replace_current_test(
  p_target_kingshot_id TEXT,
  p_expected_turn_idx INT
) RETURNS VOID AS $$
DECLARE
  state_row RECORD;
  current_holder_id TEXT;
  target_row RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state_test WHERE id = 1 FOR UPDATE;
  IF state_row.current_turn_idx != p_expected_turn_idx THEN
    RAISE EXCEPTION 'turn_changed';
  END IF;

  SELECT kingshot_id INTO current_holder_id FROM kvk_buff_participants_test
  WHERE turn_idx = state_row.current_turn_idx;
  IF current_holder_id IS NULL THEN
    RAISE EXCEPTION 'no_current_holder';
  END IF;
  IF current_holder_id = p_target_kingshot_id THEN
    RAISE EXCEPTION 'same_target';
  END IF;

  SELECT * INTO target_row FROM kvk_buff_participants_test
  WHERE kingshot_id = p_target_kingshot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target_not_found';
  END IF;
  IF target_row.slot_idx IS NOT NULL THEN
    RAISE EXCEPTION 'target_already_picked';
  END IF;

  UPDATE kvk_buff_participants_test
  SET turn_idx = CASE
    WHEN kingshot_id = current_holder_id THEN target_row.turn_idx
    WHEN kingshot_id = p_target_kingshot_id THEN state_row.current_turn_idx
  END
  WHERE kingshot_id IN (current_holder_id, p_target_kingshot_id);
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION kvk_buff_admin_replace_current_test(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvk_buff_admin_replace_current_test(TEXT, INT) TO service_role;

-- ROLLBACK:
--   DROP FUNCTION IF EXISTS kvk_buff_admin_replace_current_test(TEXT, INT);
--   DROP FUNCTION IF EXISTS kvk_buff_admin_replace_current(TEXT, INT);
--
-- 기존 kvk_buff_admin_skip / kvk_buff_admin_skip_test 는 유지 — UI 에선 사용 안 함.
-- 추후 안정화되면 별도 마이그레이션에서 DROP.
