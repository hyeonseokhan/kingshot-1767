-- KvK 버프 예약 — admin 수동 추가 (순위권 밖 인원을 빈 슬롯에 직접 등록).
--
-- 배경/기획:
--   기존: bootstrap 으로 상위 48명만 참가 → 선착순 슬롯 픽 → admin [예약 마감].
--   추가: 마감(finalized) 이후에도 admin 이 빈 슬롯을 직접 클릭 → 킹샷 ID 입력 →
--         설문 제출자(city_level>=26)이면 그 빈 슬롯에 즉시 등록.
--   → 순위권 밖이어도 admin 재량으로 채울 수 있음. 설문 미제출자는 거부.
--
-- 설계 결정:
--   1) turn_idx 49번부터 이어붙임 → CHECK (turn_idx < 48) 제약 제거 (turn_idx >= 0 만 유지).
--      slot 은 여전히 0~47 (48칸 고정). 참가자 수 > 48 가능해짐.
--   2) admin_add 는 finalized 검증 안 함 (마감 후 등록이 본 기능의 목적).
--      bootstrap 안 됐으면 거부 (예약 시작 전엔 의미 없음).
--   3) 설문 제출자 게이트: kvk_speedup_survey 에 city_level>=26 으로 존재해야 함 (bootstrap 과 동일 기준).
--   4) 슬롯 점유 충돌 / 이미 참가자 / 미제출 각각 명시 에러.
--
-- 슬롯 부족 부작용:
--   슬롯은 48칸 고정인데 admin_add 가 빈 슬롯을 채우면, 기존 48명 중 미선택자가
--   나중에 픽하려 할 때 빈 슬롯이 없을 수 있음. pick_slot RPC 는 slot_taken/all_picked 로
--   거부하고, 클라가 "남은 자리 없음" 안내. (DB 레벨 추가 가드는 불필요 — 기존 검증이 커버.)
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS kvk_buff_admin_add(TEXT, INT);
--   DROP FUNCTION IF EXISTS kvk_buff_admin_add_test(TEXT, INT);
--   ALTER TABLE kvk_buff_participants      ADD CONSTRAINT ... CHECK (turn_idx >= 0 AND turn_idx < 48);
--   ALTER TABLE kvk_buff_participants_test ADD CONSTRAINT ... CHECK (turn_idx >= 0 AND turn_idx < 48);
--   (원본 제약은 NOT NULL CHECK (turn_idx >= 0 AND turn_idx < 48). 아래에서 이름 없이 생성됐을 수 있어
--    재부여 시 시스템 생성 이름 확인 필요.)

-- ===== 1. turn_idx 상한 제약 제거 (49번+ 이어붙임 허용) =====
-- 원본은 컬럼 인라인 CHECK 라 시스템이 자동 이름 부여 (kvk_buff_participants_turn_idx_check 형태).
-- 안전하게: 기존 인라인 제약 후보들을 동적 DROP 후, 하한만 있는 명시 제약 재생성.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname, conrelid::regclass AS tbl
    FROM pg_constraint
    WHERE conrelid IN ('kvk_buff_participants'::regclass, 'kvk_buff_participants_test'::regclass)
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%turn_idx%48%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;

ALTER TABLE kvk_buff_participants
  ADD CONSTRAINT kvk_buff_participants_turn_idx_nonneg CHECK (turn_idx >= 0);
ALTER TABLE kvk_buff_participants_test
  ADD CONSTRAINT kvk_buff_participants_test_turn_idx_nonneg CHECK (turn_idx >= 0);

-- ===== 2. admin_add RPC (운영) =====
-- 반환 TEXT: 'ok' | 'slot_taken' (slot_taken 은 RAISE 대신 RETURN — DEFERRABLE UNIQUE 우회 패턴).
-- 그 외 거부는 RAISE EXCEPTION (Edge Function 이 코드로 forward).
CREATE OR REPLACE FUNCTION kvk_buff_admin_add(
  p_kingshot_id TEXT,
  p_slot_idx    INT
) RETURNS TEXT AS $$
DECLARE
  state_row    RECORD;
  survey_row   RECORD;
  next_turn    INT;
BEGIN
  IF p_slot_idx < 0 OR p_slot_idx >= 48 THEN
    RAISE EXCEPTION 'invalid_slot_idx';
  END IF;

  SELECT * INTO state_row FROM kvk_buff_state WHERE id = 1 FOR UPDATE;
  IF state_row.bootstrapped_at IS NULL THEN
    RAISE EXCEPTION 'not_bootstrapped';
  END IF;
  -- 마감 검증 없음 — 마감 후 admin 추가가 본 기능 목적.

  -- 이미 참가자면 거부 (중복 등록 방지)
  PERFORM 1 FROM kvk_buff_participants WHERE kingshot_id = p_kingshot_id;
  IF FOUND THEN
    RAISE EXCEPTION 'already_participant';
  END IF;

  -- 설문 제출자 게이트 — bootstrap 과 동일 기준 (city_level >= 26).
  SELECT kingshot_id, (evidence_uploaded_at IS NOT NULL) AS verified
    INTO survey_row
  FROM kvk_speedup_survey
  WHERE kingshot_id = p_kingshot_id AND city_level >= 26;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_in_survey';
  END IF;

  -- 슬롯 점유 충돌 사전 확인 (DEFERRABLE UNIQUE 우회)
  PERFORM 1 FROM kvk_buff_participants WHERE slot_idx = p_slot_idx;
  IF FOUND THEN
    RETURN 'slot_taken';
  END IF;

  -- turn_idx 49번부터 이어붙임 (현재 max + 1)
  SELECT COALESCE(MAX(turn_idx), -1) + 1 INTO next_turn FROM kvk_buff_participants;

  INSERT INTO kvk_buff_participants
    (kingshot_id, turn_idx, score_rank, was_verified, slot_idx, picked_at)
  VALUES
    (p_kingshot_id, next_turn, next_turn, survey_row.verified, p_slot_idx, now());

  RETURN 'ok';
END;
$$ LANGUAGE plpgsql;

-- ===== 3. admin_add RPC (테스트) =====
CREATE OR REPLACE FUNCTION kvk_buff_admin_add_test(
  p_kingshot_id TEXT,
  p_slot_idx    INT
) RETURNS TEXT AS $$
DECLARE
  state_row    RECORD;
  survey_row   RECORD;
  next_turn    INT;
BEGIN
  IF p_slot_idx < 0 OR p_slot_idx >= 48 THEN
    RAISE EXCEPTION 'invalid_slot_idx';
  END IF;

  SELECT * INTO state_row FROM kvk_buff_state_test WHERE id = 1 FOR UPDATE;
  IF state_row.bootstrapped_at IS NULL THEN
    RAISE EXCEPTION 'not_bootstrapped';
  END IF;

  PERFORM 1 FROM kvk_buff_participants_test WHERE kingshot_id = p_kingshot_id;
  IF FOUND THEN
    RAISE EXCEPTION 'already_participant';
  END IF;

  -- _test 도 인증/회원은 운영 kvk_speedup_survey 공유 (TEST_MODE 주석 정책).
  SELECT kingshot_id, (evidence_uploaded_at IS NOT NULL) AS verified
    INTO survey_row
  FROM kvk_speedup_survey
  WHERE kingshot_id = p_kingshot_id AND city_level >= 26;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_in_survey';
  END IF;

  PERFORM 1 FROM kvk_buff_participants_test WHERE slot_idx = p_slot_idx;
  IF FOUND THEN
    RETURN 'slot_taken';
  END IF;

  SELECT COALESCE(MAX(turn_idx), -1) + 1 INTO next_turn FROM kvk_buff_participants_test;

  INSERT INTO kvk_buff_participants_test
    (kingshot_id, turn_idx, score_rank, was_verified, slot_idx, picked_at)
  VALUES
    (p_kingshot_id, next_turn, next_turn, survey_row.verified, p_slot_idx, now());

  RETURN 'ok';
END;
$$ LANGUAGE plpgsql;

-- ===== 4. 권한 =====
REVOKE EXECUTE ON FUNCTION kvk_buff_admin_add(TEXT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kvk_buff_admin_add_test(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvk_buff_admin_add(TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION kvk_buff_admin_add_test(TEXT, INT) TO service_role;
