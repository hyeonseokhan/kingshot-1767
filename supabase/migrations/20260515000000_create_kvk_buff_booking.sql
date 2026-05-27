-- KvK 버프 예약 시스템 — 설문 마감 후 상위 48명이 30분 단위 슬롯을 순차 점유하는 흐름.
--
-- 설계 요약:
--   * kvk_buff_state — single row (id=1). 차례 진행 메타 (현재 turn_idx, turn_started_at).
--   * kvk_buff_participants — 참가자 48명. turn_idx (점유 순서) + slot_idx (선택한 30분 슬롯).
--   * kvk_speedup_survey.is_admin — admin 권한 flag (스킵/swap 등 관리자 전용 액션).
--
-- 라이프사이클:
--   * 설문 마감 (UTC 5/16 01:00) 직후 첫 get-state 호출이 lazy bootstrap →
--     kvk_speedup_survey 에서 인증 우선 + 점수 순 48명 선발 → kvk_buff_participants 채움.
--   * 1위 사용자가 슬롯 점유 → current_turn_idx ++ → 다음 사용자로 차례 advance.
--   * 시즌 청소: 수동 (TRUNCATE kvk_buff_participants; UPDATE kvk_buff_state SET ...).
--
-- RLS:
--   * 두 테이블 모두 SELECT public (목록/상태 조회), INSERT/UPDATE/DELETE 차단.
--   * 변경은 Edge Function `kvk-buff` (service_role) 만 가능.

-- ===== 1. is_admin 컬럼 (kvk_speedup_survey 확장) =====
ALTER TABLE kvk_speedup_survey
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN kvk_speedup_survey.is_admin IS
  'KvK 버프 예약의 관리자 여부. 스킵/swap 액션 권한. 수동 SQL 로 부여.';

-- ===== 2. kvk_buff_state — single-row 메타 =====
CREATE TABLE IF NOT EXISTS kvk_buff_state (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  bootstrapped_at TIMESTAMPTZ,         -- 참가자 init 시각. NULL = 아직 bootstrap 안 됨.
  current_turn_idx INTEGER DEFAULT 0,  -- 0-based. 모든 사용자 선택 완료 시 >= 48.
  turn_started_at TIMESTAMPTZ,         -- 현재 차례 시작 시각 (직전 사용자의 picked_at).
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 단일 row 보장 — id=1 만 존재
INSERT INTO kvk_buff_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE kvk_buff_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "kvk_buff_state_select_all" ON kvk_buff_state
  FOR SELECT USING (true);

-- ===== 3. kvk_buff_participants — 참가자 48명 =====
CREATE TABLE IF NOT EXISTS kvk_buff_participants (
  kingshot_id  TEXT PRIMARY KEY REFERENCES kvk_speedup_survey(kingshot_id) ON DELETE CASCADE,
  turn_idx     INTEGER NOT NULL CHECK (turn_idx >= 0 AND turn_idx < 48),
  -- 점수 순 + 인증 우선 정렬 결과의 원래 순위 (스킵으로 turn_idx 가 바뀌어도 score_rank 는 보존).
  score_rank   INTEGER NOT NULL,
  -- 선발 시점에 인증 여부 snapshot (이후 evidence 변경 무관).
  was_verified BOOLEAN NOT NULL,
  -- 사용자가 선택한 30분 슬롯. 0 = 00:00, 1 = 00:30, ..., 47 = 23:30. NULL = 미점유.
  slot_idx     INTEGER CHECK (slot_idx IS NULL OR (slot_idx >= 0 AND slot_idx < 48)),
  picked_at    TIMESTAMPTZ,            -- 슬롯 점유 시각
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- 같은 슬롯 두 명 점유 불가 (정합성)
CREATE UNIQUE INDEX IF NOT EXISTS idx_kvk_buff_participants_slot_unique
  ON kvk_buff_participants (slot_idx)
  WHERE slot_idx IS NOT NULL;

-- 같은 turn_idx 두 명 불가 (정합성). 스킵 swap 은 트랜잭션 안에서 해결.
CREATE UNIQUE INDEX IF NOT EXISTS idx_kvk_buff_participants_turn_unique
  ON kvk_buff_participants (turn_idx);

ALTER TABLE kvk_buff_participants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "kvk_buff_participants_select_all" ON kvk_buff_participants
  FOR SELECT USING (true);

COMMENT ON TABLE kvk_buff_participants IS
  'KvK 버프 예약 참가자 (상위 48명). turn_idx = 차례 순서, slot_idx = 점유한 30분 슬롯.';

-- ROLLBACK (필요 시 수동):
--   DROP TABLE IF EXISTS kvk_buff_participants;
--   DROP TABLE IF EXISTS kvk_buff_state;
--   ALTER TABLE kvk_speedup_survey DROP COLUMN IF EXISTS is_admin;
