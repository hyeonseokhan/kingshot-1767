-- KvK 버프 예약 — turn_idx UNIQUE 를 DEFERRABLE INITIALLY DEFERRED 로 변경.
--
-- 배경:
--   admin-skip 의 swap UPDATE 가 단일 statement 인데도 row 단위로 즉시 unique check 되어
--   중간 상태(turn_idx 가 일시적으로 충돌)에서 23505 violation 발생.
--   기존: CREATE UNIQUE INDEX idx_kvk_buff_participants_turn_unique  (deferrable 불가)
--   변경: ALTER TABLE ... ADD CONSTRAINT ... UNIQUE (...) DEFERRABLE INITIALLY DEFERRED
--   → constraint 검증을 transaction 종료 시점으로 미뤄 statement 안의 swap 허용.
--
-- 정합성:
--   transaction 안에선 일시 충돌 가능하지만 commit 직전에 검증 → 최종 상태에 중복 있으면 여전히 abort.

-- 기존 unique index 제거 (constraint 가 아니라 index 였음 — DROP INDEX 로 충분)
DROP INDEX IF EXISTS idx_kvk_buff_participants_turn_unique;

-- deferrable unique constraint 로 재생성
ALTER TABLE kvk_buff_participants
  ADD CONSTRAINT kvk_buff_participants_turn_unique
  UNIQUE (turn_idx) DEFERRABLE INITIALLY DEFERRED;

-- ROLLBACK:
--   ALTER TABLE kvk_buff_participants DROP CONSTRAINT IF EXISTS kvk_buff_participants_turn_unique;
--   CREATE UNIQUE INDEX idx_kvk_buff_participants_turn_unique
--     ON kvk_buff_participants (turn_idx);
