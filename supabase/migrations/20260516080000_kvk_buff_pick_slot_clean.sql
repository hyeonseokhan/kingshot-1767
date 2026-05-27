-- kvk_buff_pick_slot — 편법(A/B 동적 자동 예약) 제거, 순수 선착순 48명.
--
-- 제거:
--   - 트리거 A (271811051 → slot 22 자동 등록) 전체 제거
--   - 트리거 B (270680423 → slot 11 자동 등록) 전체 제거
--
-- 유지:
--   - finalized / not_bootstrapped / not_participant / already_picked 검증
--   - slot_taken 사전 검증 (DEFERRABLE constraint 우회 — SELECT 선점 확인)
--   - 반환 타입 TEXT ('ok' | 'slot_taken') — RAISE 롤백 없이 slot_taken 전달
--
-- ROLLBACK: 20260516070000 의 kvk_buff_pick_slot 재실행.

DROP FUNCTION IF EXISTS kvk_buff_pick_slot(TEXT, INT);

CREATE OR REPLACE FUNCTION kvk_buff_pick_slot(
  p_kingshot_id TEXT,
  p_slot_idx    INT
) RETURNS TEXT AS $$
DECLARE
  state_row   RECORD;
  participant RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state WHERE id = 1 FOR UPDATE;
  IF state_row.bootstrapped_at IS NULL THEN
    RAISE EXCEPTION 'not_bootstrapped';
  END IF;
  IF state_row.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'finalized';
  END IF;

  SELECT * INTO participant FROM kvk_buff_participants WHERE kingshot_id = p_kingshot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_participant';
  END IF;
  IF participant.slot_idx IS NOT NULL THEN
    RAISE EXCEPTION 'already_picked';
  END IF;

  -- slot_taken 사전 검증 (DEFERRABLE UNIQUE constraint 는 COMMIT 시 발화 → EXCEPTION 포착 불가)
  PERFORM 1 FROM kvk_buff_participants
  WHERE slot_idx = p_slot_idx AND kingshot_id != p_kingshot_id;
  IF FOUND THEN
    RETURN 'slot_taken';
  END IF;

  UPDATE kvk_buff_participants
  SET slot_idx = p_slot_idx, picked_at = now()
  WHERE kingshot_id = p_kingshot_id;

  RETURN 'ok';
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION kvk_buff_pick_slot(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvk_buff_pick_slot(TEXT, INT) TO service_role;
