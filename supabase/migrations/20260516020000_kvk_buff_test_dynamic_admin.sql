-- !!! TEST_MODE — admin 수에 맞춰 동적 슬롯 수 !!!
--
-- 변경: bootstrap_test 의 LIMIT 6 제거 → is_admin=TRUE 인 모든 사용자 INSERT.
-- 클라 totalSlots() 도 동적 (participants.length 사용).
--
-- 운영 시나리오: 관리자가 테스트 도와줄 연맹원의 is_admin 을 TRUE 로 잠시 변경 →
-- buff overlay 에서 [재시작] → 새 admin 명단으로 슬롯 자동 INSERT.
-- 테스트 종료 후 is_admin=FALSE 로 원복.

CREATE OR REPLACE FUNCTION kvk_buff_bootstrap_test()
RETURNS VOID AS $$
DECLARE
  state_row RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state_test WHERE id = 1 FOR UPDATE;
  IF state_row.bootstrapped_at IS NOT NULL THEN
    RETURN;
  END IF;

  -- admin 모두 INSERT — LIMIT 없음. 인증 우선 + 점수 순 정렬은 유지 (UI 표시 순서).
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
  ) ranked;

  UPDATE kvk_buff_state_test SET
    bootstrapped_at = now(),
    turn_started_at = now(),
    current_turn_idx = 0,
    updated_at = now()
  WHERE id = 1;
END;
$$ LANGUAGE plpgsql;

-- ROLLBACK: 20260515000600 의 bootstrap_test (rn <= 6) 정의 재실행.
