-- 운영 kvk_buff_bootstrap — deadline 자동 시작 → admin 수동 [예약 시작] 으로 전환.
-- 변경: IF now() < deadline THEN RAISE 'before_deadline' 검사 제거.
-- admin 호출 (Edge Function admin-start) 만 받으면 INSERT.
--
-- 영향: 자동 시작 (UTC 5/16 01:00) 폐기. admin 이 클릭해야 시작.

CREATE OR REPLACE FUNCTION kvk_buff_bootstrap()
RETURNS VOID AS $$
DECLARE
  state_row RECORD;
BEGIN
  -- single row lock — 두 admin 이 동시 호출해도 직렬화
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
          kingshot_id ASC
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

-- ROLLBACK: 20260515000100 의 정의 (deadline 검사 포함) 재실행.
