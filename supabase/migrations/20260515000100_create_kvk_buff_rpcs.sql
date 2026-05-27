-- KvK 버프 예약 — atomic RPC 함수들.
-- 모든 동시성 처리 (bootstrap race / pick-slot race / swap) 는 RPC 안에서 트랜잭션 + row lock 으로.
-- Edge Function 은 token 검증 + kingshot_id 추출 후 RPC 만 호출 (정합성 책임은 RPC).

-- ===== 점수 계산 (kvk-score.ts 와 동일 공식) =====
-- 1일차: construction × 30
-- 4일차: (training + general) × 60 / effective_sec × point_per_troop
--   tier 10 (TC ≥ 30): base 152s, 60 P/troop
--   tier 9  (TC < 30): base 131s, 45 P/troop
--   speedup multiplier 2.9 (가속 버프 190%)
CREATE OR REPLACE FUNCTION kvk_predicted_score(
  p_construction INT, p_training INT, p_general INT, p_city_level INT
) RETURNS INT AS $$
DECLARE
  day1 INT;
  effective_sec NUMERIC;
  point_per_troop INT;
  troops NUMERIC;
  day4 INT;
BEGIN
  day1 := p_construction * 30;
  IF p_city_level >= 30 THEN
    effective_sec := 152.0 / 2.9;
    point_per_troop := 60;
  ELSE
    effective_sec := 131.0 / 2.9;
    point_per_troop := 45;
  END IF;
  troops := (p_training + p_general)::NUMERIC * 60 / effective_sec;
  day4 := ROUND(troops * point_per_troop);
  RETURN day1 + day4;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ===== bootstrap — 마감 후 첫 호출 시 참가자 48명 init =====
-- 인증 우선 + 점수 순. 인증자 부족하면 미인증 사용자가 점수 순으로 채움.
CREATE OR REPLACE FUNCTION kvk_buff_bootstrap()
RETURNS VOID AS $$
DECLARE
  deadline TIMESTAMPTZ := '2026-05-16T01:00:00Z';
  state_row RECORD;
BEGIN
  IF now() < deadline THEN
    RAISE EXCEPTION 'before_deadline';
  END IF;

  -- single row lock — 두 클라가 동시 호출해도 직렬화
  SELECT * INTO state_row FROM kvk_buff_state WHERE id = 1 FOR UPDATE;
  IF state_row.bootstrapped_at IS NOT NULL THEN
    RETURN; -- 이미 init 됨
  END IF;

  INSERT INTO kvk_buff_participants (kingshot_id, turn_idx, score_rank, was_verified)
  SELECT kingshot_id, rn - 1, rn - 1, was_verified
  FROM (
    SELECT
      kingshot_id,
      (evidence_uploaded_at IS NOT NULL) AS was_verified,
      ROW_NUMBER() OVER (
        ORDER BY
          CASE WHEN evidence_uploaded_at IS NOT NULL THEN 0 ELSE 1 END ASC,
          kvk_predicted_score(construction, training, general, city_level) DESC,
          kingshot_id ASC  -- tie-breaker
      ) AS rn
    FROM kvk_speedup_survey
    WHERE city_level >= 26
  ) ranked
  WHERE rn <= 48;

  UPDATE kvk_buff_state SET
    bootstrapped_at = now(),
    turn_started_at = now(),
    current_turn_idx = 0,
    updated_at = now()
  WHERE id = 1;
END;
$$ LANGUAGE plpgsql;

-- ===== pick-slot — 본인 차례 + 빈 슬롯 점유 =====
-- p_expected_turn_idx: 클라가 보는 current_turn_idx. 서버와 다르면 'turn_changed' 에러.
CREATE OR REPLACE FUNCTION kvk_buff_pick_slot(
  p_kingshot_id TEXT,
  p_slot_idx INT,
  p_expected_turn_idx INT
) RETURNS VOID AS $$
DECLARE
  state_row RECORD;
  participant RECORD;
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

  -- slot_idx UNIQUE (partial) 인덱스가 동일 슬롯 중복 점유 차단
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

-- ===== admin-skip — 현재 차례 사용자와 다음 사용자 turn_idx swap =====
CREATE OR REPLACE FUNCTION kvk_buff_admin_skip(
  p_expected_turn_idx INT
) RETURNS VOID AS $$
DECLARE
  state_row RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state WHERE id = 1 FOR UPDATE;
  IF state_row.current_turn_idx != p_expected_turn_idx THEN
    RAISE EXCEPTION 'turn_changed';
  END IF;
  IF p_expected_turn_idx + 1 >= 48 THEN
    RAISE EXCEPTION 'no_next';
  END IF;

  -- 단일 UPDATE statement — 모든 row 변경 후 unique 검증 (statement-level)
  UPDATE kvk_buff_participants
  SET turn_idx = CASE
    WHEN turn_idx = p_expected_turn_idx THEN p_expected_turn_idx + 1
    WHEN turn_idx = p_expected_turn_idx + 1 THEN p_expected_turn_idx
  END
  WHERE turn_idx IN (p_expected_turn_idx, p_expected_turn_idx + 1);
END;
$$ LANGUAGE plpgsql;

-- ===== admin-swap — 두 슬롯의 holder 교환 =====
CREATE OR REPLACE FUNCTION kvk_buff_admin_swap(
  p_slot_a_idx INT,
  p_slot_b_idx INT
) RETURNS VOID AS $$
DECLARE
  a_id TEXT;
  b_id TEXT;
BEGIN
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

-- ===== 권한 — anon 차단, service_role 만 호출 가능 =====
REVOKE EXECUTE ON FUNCTION kvk_buff_bootstrap FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kvk_buff_pick_slot(TEXT, INT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kvk_buff_admin_skip(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kvk_buff_admin_swap(INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvk_buff_bootstrap TO service_role;
GRANT EXECUTE ON FUNCTION kvk_buff_pick_slot(TEXT, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION kvk_buff_admin_skip(INT) TO service_role;
GRANT EXECUTE ON FUNCTION kvk_buff_admin_swap(INT, INT) TO service_role;

-- ROLLBACK:
--   DROP FUNCTION IF EXISTS kvk_buff_admin_swap(INT, INT);
--   DROP FUNCTION IF EXISTS kvk_buff_admin_skip(INT);
--   DROP FUNCTION IF EXISTS kvk_buff_pick_slot(TEXT, INT, INT);
--   DROP FUNCTION IF EXISTS kvk_buff_bootstrap();
--   DROP FUNCTION IF EXISTS kvk_predicted_score(INT, INT, INT, INT);
