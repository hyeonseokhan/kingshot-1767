-- ============================================================================
-- !!! TEST_MODE — 관리자 필드 테스트 종료 후 제거 대상 !!!
-- ============================================================================
--
-- 변경:
--   * kvk_buff_bootstrap_test() — admin 6명 한정으로 INSERT (인증/점수 순). LIMIT 6.
--     이전: city_level >= 26 인 모든 사용자 (22명) 중 상위 48명.
--     이후: is_admin = TRUE 만 6명. 일반 사용자 무관.
--   * kvk_buff_reset_test() — 신규. _test 참가자 TRUNCATE + state 초기화.
--     [재시작] 버튼이 호출. bootstrapped_at 을 NULL 로 되돌려 다음 get-state 가 lazy bootstrap.
--
-- 슬롯 수는 클라이언트가 6 으로 렌더 (TOTAL_SLOTS 동적). DB CHECK 는 < 48 그대로 유지 (운영 호환).

CREATE OR REPLACE FUNCTION kvk_buff_bootstrap_test()
RETURNS VOID AS $$
DECLARE
  state_row RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state_test WHERE id = 1 FOR UPDATE;
  IF state_row.bootstrapped_at IS NOT NULL THEN
    RETURN;
  END IF;

  -- admin 만 INSERT — 일반 사용자 무관, 운영 데이터 오염 X.
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
    WHERE is_admin = TRUE
  ) ranked
  WHERE rn <= 6;

  UPDATE kvk_buff_state_test SET
    bootstrapped_at = now(),
    turn_started_at = now(),
    current_turn_idx = 0,
    updated_at = now()
  WHERE id = 1;
END;
$$ LANGUAGE plpgsql;

-- 신규 — admin 이 [재시작] 버튼 누를 때 호출. _test 참가자 모두 제거 + state 초기화.
CREATE OR REPLACE FUNCTION kvk_buff_reset_test()
RETURNS VOID AS $$
BEGIN
  TRUNCATE TABLE kvk_buff_participants_test;
  UPDATE kvk_buff_state_test SET
    bootstrapped_at = NULL,
    current_turn_idx = 0,
    turn_started_at = NULL,
    updated_at = now()
  WHERE id = 1;
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION kvk_buff_reset_test FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvk_buff_reset_test TO service_role;

-- ROLLBACK (테스트 종료 시 — 본 마이그레이션 + 20260515000300 한 번에 ROLLBACK):
--   DROP FUNCTION IF EXISTS kvk_buff_reset_test();
--   -- bootstrap_test 도 20260515000300 의 정의로 복귀하려면 그 파일의 CREATE 블록 재실행.
