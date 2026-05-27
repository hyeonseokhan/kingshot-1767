-- KvK 버프 예약 — admin "예약 마감" 기능.
--
-- 마감 후엔 어느 사용자도 슬롯 등록/변경/스킵/swap 불가능. state.finalized_at 으로 표현.
-- NULL = 미마감 (정상 진행), 값 있음 = 마감 시각 (모든 mutation 차단).
--
-- 적용 대상: 운영 (kvk_buff_state) + 테스트 (kvk_buff_state_test).
-- pick_slot / admin_skip / admin_swap RPC 에도 finalized 검증 추가.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS kvk_buff_finalize();
--   DROP FUNCTION IF EXISTS kvk_buff_finalize_test();
--   ALTER TABLE kvk_buff_state DROP COLUMN IF EXISTS finalized_at;
--   ALTER TABLE kvk_buff_state_test DROP COLUMN IF EXISTS finalized_at;
--   -- pick_slot / admin_skip / admin_swap 은 이전 정의로 회귀 — 별도 RPC 재정의 필요.

-- ===== 1. finalized_at 컬럼 추가 =====
ALTER TABLE kvk_buff_state
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;
ALTER TABLE kvk_buff_state_test
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;

COMMENT ON COLUMN kvk_buff_state.finalized_at IS
  'admin "예약 마감" 호출 시각. NULL=진행 중, 값=마감(모든 mutation 차단).';

-- ===== 2. 마감 RPC — admin 권한 검증은 Edge Function 에서 (RPC 는 단순 상태 변경) =====
CREATE OR REPLACE FUNCTION kvk_buff_finalize()
RETURNS VOID AS $$
DECLARE
  state_row RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state WHERE id = 1 FOR UPDATE;
  IF state_row.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_finalized';
  END IF;
  UPDATE kvk_buff_state SET finalized_at = now(), updated_at = now() WHERE id = 1;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION kvk_buff_finalize_test()
RETURNS VOID AS $$
DECLARE
  state_row RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state_test WHERE id = 1 FOR UPDATE;
  IF state_row.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_finalized';
  END IF;
  UPDATE kvk_buff_state_test SET finalized_at = now(), updated_at = now() WHERE id = 1;
END;
$$ LANGUAGE plpgsql;

-- ===== 3. 기존 RPC 들에 finalized 검증 추가 =====
-- pick_slot / pick_slot_test — 본인 차례 검증 직전에 finalized 차단.

CREATE OR REPLACE FUNCTION kvk_buff_pick_slot(
  p_kingshot_id TEXT,
  p_slot_idx INT,
  p_expected_turn_idx INT
) RETURNS VOID AS $$
DECLARE
  state_row RECORD;
  participant RECORD;
  taken_by TEXT;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state WHERE id = 1 FOR UPDATE;
  IF state_row.bootstrapped_at IS NULL THEN
    RAISE EXCEPTION 'not_bootstrapped';
  END IF;
  IF state_row.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'finalized';
  END IF;
  IF state_row.current_turn_idx != p_expected_turn_idx THEN
    RAISE EXCEPTION 'turn_changed';
  END IF;
  IF state_row.current_turn_idx >= 48 THEN
    RAISE EXCEPTION 'all_picked';
  END IF;

  SELECT * INTO participant FROM kvk_buff_participants
  WHERE kingshot_id = p_kingshot_id AND turn_idx = state_row.current_turn_idx;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_your_turn';
  END IF;
  IF participant.slot_idx IS NOT NULL THEN
    RAISE EXCEPTION 'already_picked';
  END IF;

  SELECT kingshot_id INTO taken_by FROM kvk_buff_participants
  WHERE slot_idx = p_slot_idx AND kingshot_id != p_kingshot_id;
  IF FOUND THEN
    RAISE EXCEPTION 'slot_taken';
  END IF;

  UPDATE kvk_buff_participants
  SET slot_idx = p_slot_idx, picked_at = now()
  WHERE kingshot_id = p_kingshot_id;

  UPDATE kvk_buff_state SET
    current_turn_idx = current_turn_idx + 1,
    turn_started_at = now(),
    updated_at = now()
  WHERE id = 1;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION kvk_buff_pick_slot_test(
  p_kingshot_id TEXT,
  p_slot_idx INT,
  p_expected_turn_idx INT
) RETURNS VOID AS $$
DECLARE
  state_row RECORD;
  participant RECORD;
  taken_by TEXT;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state_test WHERE id = 1 FOR UPDATE;
  IF state_row.bootstrapped_at IS NULL THEN
    RAISE EXCEPTION 'not_bootstrapped';
  END IF;
  IF state_row.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'finalized';
  END IF;
  IF state_row.current_turn_idx != p_expected_turn_idx THEN
    RAISE EXCEPTION 'turn_changed';
  END IF;
  IF state_row.current_turn_idx >= 48 THEN
    RAISE EXCEPTION 'all_picked';
  END IF;

  SELECT * INTO participant FROM kvk_buff_participants_test
  WHERE kingshot_id = p_kingshot_id AND turn_idx = state_row.current_turn_idx;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_your_turn';
  END IF;
  IF participant.slot_idx IS NOT NULL THEN
    RAISE EXCEPTION 'already_picked';
  END IF;

  SELECT kingshot_id INTO taken_by FROM kvk_buff_participants_test
  WHERE slot_idx = p_slot_idx AND kingshot_id != p_kingshot_id;
  IF FOUND THEN
    RAISE EXCEPTION 'slot_taken';
  END IF;

  UPDATE kvk_buff_participants_test
  SET slot_idx = p_slot_idx, picked_at = now()
  WHERE kingshot_id = p_kingshot_id;

  UPDATE kvk_buff_state_test SET
    current_turn_idx = current_turn_idx + 1,
    turn_started_at = now(),
    updated_at = now()
  WHERE id = 1;
END;
$$ LANGUAGE plpgsql;

-- admin_skip / admin_swap — 마감 후 admin 도 변경 불가 (확정 상태 보장).
CREATE OR REPLACE FUNCTION kvk_buff_admin_skip(
  p_expected_turn_idx INT
) RETURNS VOID AS $$
DECLARE
  state_row RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state WHERE id = 1 FOR UPDATE;
  IF state_row.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'finalized';
  END IF;
  IF state_row.current_turn_idx != p_expected_turn_idx THEN
    RAISE EXCEPTION 'turn_changed';
  END IF;
  IF p_expected_turn_idx + 1 >= 48 THEN
    RAISE EXCEPTION 'no_next';
  END IF;

  UPDATE kvk_buff_participants
  SET turn_idx = CASE
    WHEN turn_idx = p_expected_turn_idx THEN p_expected_turn_idx + 1
    WHEN turn_idx = p_expected_turn_idx + 1 THEN p_expected_turn_idx
  END
  WHERE turn_idx IN (p_expected_turn_idx, p_expected_turn_idx + 1);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION kvk_buff_admin_skip_test(
  p_expected_turn_idx INT
) RETURNS VOID AS $$
DECLARE
  state_row RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state_test WHERE id = 1 FOR UPDATE;
  IF state_row.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'finalized';
  END IF;
  IF state_row.current_turn_idx != p_expected_turn_idx THEN
    RAISE EXCEPTION 'turn_changed';
  END IF;
  IF p_expected_turn_idx + 1 >= 48 THEN
    RAISE EXCEPTION 'no_next';
  END IF;

  UPDATE kvk_buff_participants_test
  SET turn_idx = CASE
    WHEN turn_idx = p_expected_turn_idx THEN p_expected_turn_idx + 1
    WHEN turn_idx = p_expected_turn_idx + 1 THEN p_expected_turn_idx
  END
  WHERE turn_idx IN (p_expected_turn_idx, p_expected_turn_idx + 1);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION kvk_buff_admin_swap(
  p_slot_a_idx INT,
  p_slot_b_idx INT
) RETURNS VOID AS $$
DECLARE
  state_row RECORD;
  a_id TEXT;
  b_id TEXT;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state WHERE id = 1 FOR UPDATE;
  IF state_row.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'finalized';
  END IF;

  SELECT kingshot_id INTO a_id FROM kvk_buff_participants WHERE slot_idx = p_slot_a_idx;
  SELECT kingshot_id INTO b_id FROM kvk_buff_participants WHERE slot_idx = p_slot_b_idx;
  IF a_id IS NULL OR b_id IS NULL THEN
    RAISE EXCEPTION 'slot_not_occupied';
  END IF;

  UPDATE kvk_buff_participants
  SET slot_idx = CASE
    WHEN kingshot_id = a_id THEN p_slot_b_idx
    WHEN kingshot_id = b_id THEN p_slot_a_idx
  END
  WHERE kingshot_id IN (a_id, b_id);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION kvk_buff_admin_swap_test(
  p_slot_a_idx INT,
  p_slot_b_idx INT
) RETURNS VOID AS $$
DECLARE
  state_row RECORD;
  a_id TEXT;
  b_id TEXT;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state_test WHERE id = 1 FOR UPDATE;
  IF state_row.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'finalized';
  END IF;

  SELECT kingshot_id INTO a_id FROM kvk_buff_participants_test WHERE slot_idx = p_slot_a_idx;
  SELECT kingshot_id INTO b_id FROM kvk_buff_participants_test WHERE slot_idx = p_slot_b_idx;
  IF a_id IS NULL OR b_id IS NULL THEN
    RAISE EXCEPTION 'slot_not_occupied';
  END IF;

  UPDATE kvk_buff_participants_test
  SET slot_idx = CASE
    WHEN kingshot_id = a_id THEN p_slot_b_idx
    WHEN kingshot_id = b_id THEN p_slot_a_idx
  END
  WHERE kingshot_id IN (a_id, b_id);
END;
$$ LANGUAGE plpgsql;

-- ===== 4. 권한 =====
REVOKE EXECUTE ON FUNCTION kvk_buff_finalize() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kvk_buff_finalize_test() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvk_buff_finalize() TO service_role;
GRANT EXECUTE ON FUNCTION kvk_buff_finalize_test() TO service_role;
