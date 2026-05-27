-- KvK 버프 예약 — slot_idx UNIQUE 를 DEFERRABLE 로 변경 + pick_slot 에 slot 점유 사전 검증.
--
-- 발견된 두 가지 23505 케이스:
--
-- (1) 스킵 후 점유된 슬롯 선택:
--     A 의 차례에 admin_skip 으로 turn 이동 → 다른 사용자 B 가 슬롯 X 점유 →
--     A 의 후속 차례에서 슬롯 X 클릭 (클라 stale 또는 사용자 실수) →
--     pick_slot RPC 가 "다른 사용자 점유 여부" 미검증 → UPDATE 시 UNIQUE violation 23505.
--
--     fix: pick_slot RPC 의 본인 검증 직후, "p_slot_idx 가 다른 row 에 이미 점유" 면
--          'slot_taken' 친화적 에러 발생. UNIQUE constraint 에 도달하기 전 차단.
--
-- (2) admin-swap 시 row-level 즉시 충돌:
--     admin_swap UPDATE 가 단일 statement 안에서 두 row 의 slot_idx 동시 변경.
--     기존 slot_idx UNIQUE 가 partial INDEX (immediate 검증) → 첫 row 변경 직후
--     중간 상태에서 23505 violation.
--
--     fix: turn_idx 와 동일하게 slot_idx 도 DEFERRABLE INITIALLY DEFERRED 로 변경.
--          transaction 종료 시점에 최종 상태만 검증 → statement 안 swap 허용.
--
-- 적용 대상: 운영 (kvk_buff_participants) + 테스트 (kvk_buff_participants_test) 둘 다.

-- ===== 1. slot_idx UNIQUE 를 DEFERRABLE 로 재구성 =====

-- 운영
DROP INDEX IF EXISTS idx_kvk_buff_participants_slot_unique;
ALTER TABLE kvk_buff_participants
  ADD CONSTRAINT kvk_buff_participants_slot_unique
  UNIQUE (slot_idx) DEFERRABLE INITIALLY DEFERRED;

-- 테스트 — LIKE INCLUDING ALL 로 자동 복사된 인덱스(이름: kvk_buff_participants_test_slot_idx_idx)
DROP INDEX IF EXISTS kvk_buff_participants_test_slot_idx_idx;
ALTER TABLE kvk_buff_participants_test
  ADD CONSTRAINT kvk_buff_participants_test_slot_unique
  UNIQUE (slot_idx) DEFERRABLE INITIALLY DEFERRED;

-- ===== 2. pick_slot RPC — 다른 사용자 점유 슬롯이면 친화적 에러 =====

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

  -- 점유 사전 검증 — 다른 사용자가 같은 슬롯을 이미 잡았으면 'slot_taken' 으로 친화적 종료.
  -- (DB UNIQUE constraint 의 raw 23505 가 클라까지 전파되지 않도록 차단.)
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

-- 테스트 RPC — 운영과 동일 로직, _test 테이블 사용.
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

-- ROLLBACK:
--   -- pick_slot RPC 는 이전 정의로 회귀 (slot_taken 검증 제거) — 운영 코드 참조해 수동 작성.
--   -- slot_idx UNIQUE 재구성:
--   ALTER TABLE kvk_buff_participants DROP CONSTRAINT IF EXISTS kvk_buff_participants_slot_unique;
--   CREATE UNIQUE INDEX idx_kvk_buff_participants_slot_unique
--     ON kvk_buff_participants (slot_idx) WHERE slot_idx IS NOT NULL;
--   ALTER TABLE kvk_buff_participants_test DROP CONSTRAINT IF EXISTS kvk_buff_participants_test_slot_unique;
--   CREATE UNIQUE INDEX kvk_buff_participants_test_slot_idx_idx
--     ON kvk_buff_participants_test (slot_idx) WHERE slot_idx IS NOT NULL;
