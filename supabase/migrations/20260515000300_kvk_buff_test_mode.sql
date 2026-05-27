-- ============================================================================
-- !!! TEST_MODE — 관리자 필드 테스트 종료 후 제거 대상 !!!
-- ============================================================================
--
-- 목적:
--   운영 KvK 버프 예약 데이터 (kvk_buff_state, kvk_buff_participants) 와
--   격리된 테스트용 테이블 + RPC. 운영 시즌 진행 중에 관리자들이 buff 흐름을
--   자유롭게 시험할 수 있도록 분리.
--
-- 격리 범위:
--   * buff 테이블 2개 (_test) — 운영 buff 데이터와 100% 분리.
--   * RPC 4개 (_test) — 운영 RPC 와 별개 (DROP 만 하면 운영 무영향).
--   * 인증/회원 (kvk_speedup_survey) 은 운영 그대로 공유 — 관리자 본인 PIN 으로 로그인.
--     운영 회원 22명을 _test buff 의 참가자 후보로 그대로 사용.
--
-- 활성화 흐름:
--   1) 클라가 URL `?test=1` 으로 접속 → TypeScript TEST_MODE = true
--   2) Edge Function 호출 body 에 `test_mode: true` 동봉
--   3) Edge Function 이 _test 테이블/RPC 분기 호출 → 격리 실행
--
-- 테스트 종료 시 일괄 제거:
--   1) `TEST_MODE` 키워드로 grep — 모든 분기 위치 검색됨
--      (마이그레이션 SQL, Edge Function, survey-kvk.ts, survey-kvk-buff.ts)
--   2) 본 SQL 파일 하단의 ROLLBACK 블록 SQL 실행 → _test 테이블 + RPC 제거
--   3) 클라/Edge Function 의 TEST_MODE 분기 코드 제거
--   4) 본 마이그레이션 파일 삭제 + supabase migrations 동기화

-- ===== _test 테이블 (스키마는 운영과 동일, FK 만 운영 survey 참조) =====
-- LIKE INCLUDING ALL = DEFAULTS, IDENTITY, CONSTRAINTS, INDEXES, STORAGE, COMMENTS.
-- 하지만 FK constraint 는 LIKE 가 옮기지 않음 → 별도 ADD.

CREATE TABLE IF NOT EXISTS kvk_buff_state_test (LIKE kvk_buff_state INCLUDING ALL);
INSERT INTO kvk_buff_state_test (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE kvk_buff_state_test ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kvk_buff_state_test_select_all" ON kvk_buff_state_test
  FOR SELECT USING (true);

CREATE TABLE IF NOT EXISTS kvk_buff_participants_test (LIKE kvk_buff_participants INCLUDING ALL);
-- FK: 운영 kvk_speedup_survey 참조 (관리자 회원이 그대로 참가자 후보).
ALTER TABLE kvk_buff_participants_test
  ADD CONSTRAINT kvk_buff_participants_test_kingshot_id_fkey
    FOREIGN KEY (kingshot_id) REFERENCES kvk_speedup_survey(kingshot_id) ON DELETE CASCADE;
-- turn_idx UNIQUE — 처음부터 deferrable (admin-skip swap 대비).
ALTER TABLE kvk_buff_participants_test
  ADD CONSTRAINT kvk_buff_participants_test_turn_unique
    UNIQUE (turn_idx) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE kvk_buff_participants_test ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kvk_buff_participants_test_select_all" ON kvk_buff_participants_test
  FOR SELECT USING (true);

COMMENT ON TABLE kvk_buff_state_test IS
  'TEST_MODE: 관리자 필드 테스트용 buff state (운영 kvk_buff_state 와 격리).';
COMMENT ON TABLE kvk_buff_participants_test IS
  'TEST_MODE: 관리자 필드 테스트용 buff 참가자 (운영 kvk_buff_participants 와 격리).';

-- ===== _test RPC (운영 RPC 와 동일 로직, _test 테이블 사용) =====
-- bootstrap_test 는 deadline 검증 skip — 테스트는 항상 마감 후로 간주.

CREATE OR REPLACE FUNCTION kvk_buff_bootstrap_test()
RETURNS VOID AS $$
DECLARE
  state_row RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state_test WHERE id = 1 FOR UPDATE;
  IF state_row.bootstrapped_at IS NOT NULL THEN
    RETURN;
  END IF;

  INSERT INTO kvk_buff_participants_test (kingshot_id, turn_idx, score_rank, was_verified)
  SELECT kingshot_id, rn - 1, rn - 1, was_verified
  FROM (
    SELECT
      kingshot_id,
      (evidence_uploaded_at IS NOT NULL) AS was_verified,
      ROW_NUMBER() OVER (
        ORDER BY
          CASE WHEN evidence_uploaded_at IS NOT NULL THEN 0 ELSE 1 END ASC,
          kvk_predicted_score(construction, training, general, city_level) DESC,
          kingshot_id ASC
      ) AS rn
    FROM kvk_speedup_survey
    WHERE city_level >= 26
  ) ranked
  WHERE rn <= 48;

  UPDATE kvk_buff_state_test SET
    bootstrapped_at = now(),
    turn_started_at = now(),
    current_turn_idx = 0,
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

CREATE OR REPLACE FUNCTION kvk_buff_admin_skip_test(
  p_expected_turn_idx INT
) RETURNS VOID AS $$
DECLARE
  state_row RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state_test WHERE id = 1 FOR UPDATE;
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

CREATE OR REPLACE FUNCTION kvk_buff_admin_swap_test(
  p_slot_a_idx INT,
  p_slot_b_idx INT
) RETURNS VOID AS $$
DECLARE
  a_id TEXT;
  b_id TEXT;
BEGIN
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

-- ===== 권한 — anon 차단, service_role 만 호출 =====
REVOKE EXECUTE ON FUNCTION kvk_buff_bootstrap_test FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kvk_buff_pick_slot_test(TEXT, INT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kvk_buff_admin_skip_test(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kvk_buff_admin_swap_test(INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvk_buff_bootstrap_test TO service_role;
GRANT EXECUTE ON FUNCTION kvk_buff_pick_slot_test(TEXT, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION kvk_buff_admin_skip_test(INT) TO service_role;
GRANT EXECUTE ON FUNCTION kvk_buff_admin_swap_test(INT, INT) TO service_role;

-- ============================================================================
-- ROLLBACK (테스트 종료 시 일괄 실행 — !!! TEST_MODE 제거 표지 !!!):
-- ============================================================================
--   DROP FUNCTION IF EXISTS kvk_buff_admin_swap_test(INT, INT);
--   DROP FUNCTION IF EXISTS kvk_buff_admin_skip_test(INT);
--   DROP FUNCTION IF EXISTS kvk_buff_pick_slot_test(TEXT, INT, INT);
--   DROP FUNCTION IF EXISTS kvk_buff_bootstrap_test();
--   DROP TABLE IF EXISTS kvk_buff_participants_test;
--   DROP TABLE IF EXISTS kvk_buff_state_test;
