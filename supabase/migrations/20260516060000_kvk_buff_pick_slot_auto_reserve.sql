-- KvK 버프 — 동적 자동 예약 (A/B) + slot_taken 사전 검증.
--
-- 변경 사항:
--   1. kvk_buff_bootstrap — 20260516050000 의 사전 예약 블록 제거. 20260516030000 버전으로 복귀.
--      부트스트랩 시 A/B 슬롯 점유 X. 이하 픽슬롯 트리거로 대체.
--
--   2. kvk_buff_pick_slot — 동적 자동 예약:
--
--      트리거 A (kingshot_id '271811051', slot 22):
--        (a) 완료된 픽 수 = 4 에 도달 → A 가 5번째로 등록
--        (b) 누군가가 slot 22 를 시도 → A 가 선점 후 요청자에게 'slot_taken' 반환
--
--      트리거 B (kingshot_id '270680423', slot 11):
--        (a) 완료된 픽 수 = 6 에 도달 → B 가 7번째로 등록
--        (b) 누군가가 slot 11 을 시도 → B 가 선점 후 요청자에게 'slot_taken' 반환
--
--      규칙: B 트리거 발화 시 A 가 미등록이면 동시 등록 (A 가 먼저 끼어듦).
--             A 가 직접 RPC 호출하면 트리거 스킵 → 정상 픽 처리.
--
--   3. slot_taken 사전 검증 — DEFERRABLE constraint 는 COMMIT 시 발화 → EXCEPTION 블록 포착 불가.
--      UPDATE 전 SELECT 로 선점 여부 확인 후 'slot_taken' 선제 발생.
--
-- A/B 가 top 48 참가자이면 ON CONFLICT(kingshot_id) DO UPDATE 로 slot_idx 만 갱신.
-- top 48 외이면 turn_idx=48(A)/49(B), score_rank=48/49, was_verified=FALSE 로 신규 삽입.
--
-- ROLLBACK:
--   -- bootstrap: 20260516050000 의 kvk_buff_bootstrap 재실행.
--   -- pick_slot: 20260516040000 의 kvk_buff_pick_slot 재실행.

-- ===== 1. kvk_buff_bootstrap — 사전 예약 블록 제거 (20260516030000 버전 복귀) =====

CREATE OR REPLACE FUNCTION kvk_buff_bootstrap()
RETURNS VOID AS $$
DECLARE
  state_row RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state WHERE id = 1 FOR UPDATE;
  IF state_row.bootstrapped_at IS NOT NULL THEN
    RETURN;
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

-- ===== 2. kvk_buff_pick_slot — 동적 자동 예약 + slot_taken 사전 검증 =====

DROP FUNCTION IF EXISTS kvk_buff_pick_slot(TEXT, INT);

CREATE OR REPLACE FUNCTION kvk_buff_pick_slot(
  p_kingshot_id TEXT,
  p_slot_idx    INT
) RETURNS VOID AS $$
DECLARE
  state_row   RECORD;
  participant RECORD;
  picked_count INT;
  a_registered BOOLEAN := FALSE;
  b_registered BOOLEAN := FALSE;
  a_id  TEXT := '271811051';
  b_id  TEXT := '270680423';
  a_slot INT  := 22;
  b_slot INT  := 11;
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

  -- A/B 현재 등록 상태 (slot_idx 점유 여부)
  SELECT (slot_idx IS NOT NULL) INTO a_registered FROM kvk_buff_participants WHERE kingshot_id = a_id;
  IF NOT FOUND THEN a_registered := FALSE; END IF;

  SELECT (slot_idx IS NOT NULL) INTO b_registered FROM kvk_buff_participants WHERE kingshot_id = b_id;
  IF NOT FOUND THEN b_registered := FALSE; END IF;

  -- 현재까지 완료된 픽 수
  SELECT COUNT(*) INTO picked_count FROM kvk_buff_participants WHERE slot_idx IS NOT NULL;

  -- ── 트리거 B: (a) 6번째 도달 또는 (b) slot 11 시도 ──
  -- A 가 직접 호출하는 경우는 제외 (A 가 slot 11 시도 → 정상 처리).
  IF NOT b_registered AND p_kingshot_id != b_id
     AND (p_slot_idx = b_slot OR picked_count = 6) THEN

    -- B 등록 (이미 top-48 참가자면 slot_idx 만 갱신, 아니면 신규 삽입)
    INSERT INTO kvk_buff_participants
      (kingshot_id, turn_idx, score_rank, was_verified, slot_idx, picked_at)
    VALUES (b_id, 49, 49, FALSE, b_slot, now())
    ON CONFLICT (kingshot_id) DO UPDATE
      SET slot_idx = b_slot, picked_at = now()
      WHERE kvk_buff_participants.slot_idx IS NULL;

    -- B 트리거 발화 시 A 도 미등록이면 동시 등록 (A 가 먼저 끼어듦)
    IF NOT a_registered THEN
      INSERT INTO kvk_buff_participants
        (kingshot_id, turn_idx, score_rank, was_verified, slot_idx, picked_at)
      VALUES (a_id, 48, 48, FALSE, a_slot, now())
      ON CONFLICT (kingshot_id) DO UPDATE
        SET slot_idx = a_slot, picked_at = now()
        WHERE kvk_buff_participants.slot_idx IS NULL;
    END IF;

    RAISE EXCEPTION 'slot_taken';
  END IF;

  -- ── 트리거 A: (a) 4번째 도달 또는 (b) slot 22 시도 ──
  -- B 가 직접 호출하는 경우 제외 (B 가 slot 22 시도 → 정상 처리).
  IF NOT a_registered AND p_kingshot_id != a_id
     AND (p_slot_idx = a_slot OR picked_count = 4) THEN

    INSERT INTO kvk_buff_participants
      (kingshot_id, turn_idx, score_rank, was_verified, slot_idx, picked_at)
    VALUES (a_id, 48, 48, FALSE, a_slot, now())
    ON CONFLICT (kingshot_id) DO UPDATE
      SET slot_idx = a_slot, picked_at = now()
      WHERE kvk_buff_participants.slot_idx IS NULL;

    RAISE EXCEPTION 'slot_taken';
  END IF;

  -- ── slot_taken 사전 검증 (DEFERRABLE constraint 우회) ──
  PERFORM 1 FROM kvk_buff_participants
  WHERE slot_idx = p_slot_idx AND kingshot_id != p_kingshot_id;
  IF FOUND THEN
    RAISE EXCEPTION 'slot_taken';
  END IF;

  -- ── 정상 픽 ──
  UPDATE kvk_buff_participants
  SET slot_idx = p_slot_idx, picked_at = now()
  WHERE kingshot_id = p_kingshot_id;
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION kvk_buff_pick_slot(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvk_buff_pick_slot(TEXT, INT) TO service_role;
