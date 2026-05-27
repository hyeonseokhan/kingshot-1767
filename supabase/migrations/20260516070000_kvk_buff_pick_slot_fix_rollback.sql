-- kvk_buff_pick_slot — RAISE EXCEPTION 롤백 버그 수정.
--
-- 문제:
--   A/B 동적 트리거 발화 시 INSERT 직후 RAISE EXCEPTION 'slot_taken' 을 올리면
--   PostgreSQL 이 해당 트랜잭션 전체를 롤백 → INSERT 도 함께 취소.
--   결과: A/B 는 영원히 등록되지 않음.
--   특히 count 기반 트리거(picked_count=4)가 발화하면 4번째 픽 이후 모든 픽 시도가
--   트리거→롤백→slot_taken 무한 루프에 빠져 시스템이 멈춤.
--
-- 수정:
--   반환 타입 VOID → TEXT.
--   트리거 발화 시: INSERT 후 RETURN 'slot_taken' (RAISE 아님) → INSERT 가 커밋됨.
--   slot_taken 사전 검증 (비-트리거): RETURN 'slot_taken' (상태 변경 없으므로 RAISE 와 동일 효과).
--   정상 픽 완료: RETURN 'ok'.
--   진짜 에러 (not_bootstrapped 등): RAISE EXCEPTION 유지 (서버 에러로 처리해야 하는 비정상 상태).
--
--   Edge Function pickSlot() 도 반환값 TEXT 를 확인하도록 함께 변경.
--   (kvk-buff/index.ts 는 별도 deploy 필요 — 본 마이그레이션과 동시 적용.)
--
-- ROLLBACK: 20260516060000 의 kvk_buff_pick_slot 재실행.

DROP FUNCTION IF EXISTS kvk_buff_pick_slot(TEXT, INT);

CREATE OR REPLACE FUNCTION kvk_buff_pick_slot(
  p_kingshot_id TEXT,
  p_slot_idx    INT
) RETURNS TEXT AS $$
DECLARE
  state_row    RECORD;
  participant  RECORD;
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

  -- A/B 현재 등록 상태
  SELECT (slot_idx IS NOT NULL) INTO a_registered FROM kvk_buff_participants WHERE kingshot_id = a_id;
  IF NOT FOUND THEN a_registered := FALSE; END IF;

  SELECT (slot_idx IS NOT NULL) INTO b_registered FROM kvk_buff_participants WHERE kingshot_id = b_id;
  IF NOT FOUND THEN b_registered := FALSE; END IF;

  -- 현재 완료된 픽 수
  SELECT COUNT(*) INTO picked_count FROM kvk_buff_participants WHERE slot_idx IS NOT NULL;

  -- ── 트리거 B: (a) 6번째 도달 또는 (b) slot 11 시도 ──
  IF NOT b_registered AND p_kingshot_id != b_id
     AND (p_slot_idx = b_slot OR picked_count = 6) THEN

    INSERT INTO kvk_buff_participants
      (kingshot_id, turn_idx, score_rank, was_verified, slot_idx, picked_at)
    VALUES (b_id, 49, 49, FALSE, b_slot, now())
    ON CONFLICT (kingshot_id) DO UPDATE
      SET slot_idx = b_slot, picked_at = now()
      WHERE kvk_buff_participants.slot_idx IS NULL;

    IF NOT a_registered THEN
      INSERT INTO kvk_buff_participants
        (kingshot_id, turn_idx, score_rank, was_verified, slot_idx, picked_at)
      VALUES (a_id, 48, 48, FALSE, a_slot, now())
      ON CONFLICT (kingshot_id) DO UPDATE
        SET slot_idx = a_slot, picked_at = now()
        WHERE kvk_buff_participants.slot_idx IS NULL;
    END IF;

    -- RAISE 가 아닌 RETURN → INSERT 가 트랜잭션과 함께 커밋됨.
    RETURN 'slot_taken';
  END IF;

  -- ── 트리거 A: (a) 4번째 도달 또는 (b) slot 22 시도 ──
  IF NOT a_registered AND p_kingshot_id != a_id
     AND (p_slot_idx = a_slot OR picked_count = 4) THEN

    INSERT INTO kvk_buff_participants
      (kingshot_id, turn_idx, score_rank, was_verified, slot_idx, picked_at)
    VALUES (a_id, 48, 48, FALSE, a_slot, now())
    ON CONFLICT (kingshot_id) DO UPDATE
      SET slot_idx = a_slot, picked_at = now()
      WHERE kvk_buff_participants.slot_idx IS NULL;

    RETURN 'slot_taken';
  END IF;

  -- ── slot_taken 사전 검증 (DEFERRABLE constraint 우회) ──
  PERFORM 1 FROM kvk_buff_participants
  WHERE slot_idx = p_slot_idx AND kingshot_id != p_kingshot_id;
  IF FOUND THEN
    RETURN 'slot_taken';
  END IF;

  -- ── 정상 픽 ──
  UPDATE kvk_buff_participants
  SET slot_idx = p_slot_idx, picked_at = now()
  WHERE kingshot_id = p_kingshot_id;

  RETURN 'ok';
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION kvk_buff_pick_slot(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvk_buff_pick_slot(TEXT, INT) TO service_role;
