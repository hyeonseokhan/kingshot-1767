-- !!! 편법 (admin 사전 예약) — admin 이 [예약 시작] 클릭 시점에 두 특정 kingshot_id 가
-- top 48 ranking INSERT 결과 안에 들어왔다면 지정 슬롯을 자동 점유.
-- 다른 사용자가 인지/회피 불가 (서버 RPC 내부 처리, 클라 응답은 일반 state).
--
-- 적용 ID & 슬롯:
--   * 271811051 → slot_idx 22 (KST 20:00 / UTC 11:00)
--   * 270680423 → slot_idx 11 (KST 14:30 / UTC 05:30)
--
-- 동작:
--   1) 기존 top 48 INSERT 그대로 (verified-first → score desc).
--   2) INSERT 후 두 ID 에 대해 UPDATE — participants 안에 있을 때만 (= top 48 안일 때만) 매칭.
--      미인증/미등록/49위 이하면 매칭 row 0 → silent no-op.
--   3) 두 슬롯이 서로 다르므로 UNIQUE 충돌 X.
--   4) 마감 후 admin [예약 시작] 1회만 호출되므로 idempotent 보호 필요 없음
--      (state.bootstrapped_at IS NOT NULL 이면 RPC 가 RETURN — UPDATE 도 안 돌아감).
--
-- 운영 종료 절차:
--   행사 종료 후 본 마이그레이션 + 20260516030000 의 정의를 재실행하면 preassign 제거된 형태로 복귀.
--
-- ROLLBACK: 20260516030000_kvk_buff_admin_start.sql 의 정의 재실행.

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

  -- !!! 편법 — 사전 슬롯 점유. WHERE 매칭이 곧 top 48 확인.
  UPDATE kvk_buff_participants
     SET slot_idx = 22, picked_at = now()
   WHERE kingshot_id = '271811051';

  UPDATE kvk_buff_participants
     SET slot_idx = 11, picked_at = now()
   WHERE kingshot_id = '270680423';

  UPDATE kvk_buff_state SET
    bootstrapped_at = now(),
    turn_started_at = now(),
    current_turn_idx = 0,
    updated_at = now()
  WHERE id = 1;
END;
$$ LANGUAGE plpgsql;
