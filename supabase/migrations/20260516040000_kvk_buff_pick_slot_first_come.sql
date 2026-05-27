-- 운영 kvk_buff_pick_slot — 순차 → 선착순 전환.
--
-- 변경:
--   - turn_idx 검증 (current_turn_idx 일치) 제거 — 누구든 미점유 슬롯 픽 가능.
--   - state.current_turn_idx 갱신 제거 (의미 X).
--   - 시그니처 변경: (TEXT, INT, INT) → (TEXT, INT). expected_turn_idx 제거.
--
-- 검증 유지:
--   - 본인 미점유 (slot_idx IS NULL)
--   - 슬롯 비어있음 (UNIQUE constraint, 위반 시 'slot_taken')
--   - 마감되지 않음 (finalized_at IS NULL)
--
-- 클라이언트 UX 변화: "현재 차례" 카드 → "선착순 진행 N/48" 진행률 카드.

DROP FUNCTION IF EXISTS kvk_buff_pick_slot(TEXT, INT, INT);

CREATE OR REPLACE FUNCTION kvk_buff_pick_slot(
  p_kingshot_id TEXT,
  p_slot_idx INT
) RETURNS VOID AS $$
DECLARE
  state_row RECORD;
  participant RECORD;
BEGIN
  SELECT * INTO state_row FROM kvk_buff_state WHERE id = 1 FOR UPDATE;
  IF state_row.bootstrapped_at IS NULL THEN
    RAISE EXCEPTION 'not_bootstrapped';
  END IF;
  IF state_row.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'finalized';
  END IF;

  SELECT * INTO participant FROM kvk_buff_participants
  WHERE kingshot_id = p_kingshot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_participant';
  END IF;
  IF participant.slot_idx IS NOT NULL THEN
    RAISE EXCEPTION 'already_picked';
  END IF;

  -- slot_idx UNIQUE (partial) 인덱스가 동일 슬롯 동시 점유 차단 → race 시 unique_violation.
  -- 'slot_taken' 으로 명시 에러 변환 — 클라가 i18n 키로 친화적 메시지 노출.
  BEGIN
    UPDATE kvk_buff_participants
    SET slot_idx = p_slot_idx, picked_at = now()
    WHERE kingshot_id = p_kingshot_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'slot_taken';
  END;

  -- 선착순 모드: state.current_turn_idx 갱신 X (차례 개념 없음). 진행률은 클라가 카운트.
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION kvk_buff_pick_slot(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvk_buff_pick_slot(TEXT, INT) TO service_role;

-- ROLLBACK: 20260515000100 의 정의 (turn_idx 검사 포함, 시그니처 TEXT/INT/INT) 재실행.
