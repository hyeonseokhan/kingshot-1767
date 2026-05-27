-- KvK 계산기 입력값 영속화 — kingshot_id 별 1 row.
--
-- 페이지 (/game-tools/kvk-calculator/) 는 클라이언트 가드로 kingshot_id = '270680423' 만 사용 가능.
-- 동일 정책을 DB RLS 에도 적용해, anon key 로 직접 호출해도 다른 ID 는 차단되도록 한다.
--
-- fields JSONB 스키마 (페이지 측이 관리):
--   { infantry, cavalry, archers,
--     accelCommon, accelTraining, accelBuilding,
--     deadline,
--     bonusH3, bonusH1, bonusM5, bonusM1 }
--   대사관 잔여(snapshot + measuredAt) 는 클라 상수라 DB 저장 대상 외.

CREATE TABLE kvk_calculator_state (
  kingshot_id TEXT PRIMARY KEY REFERENCES members(kingshot_id) ON DELETE CASCADE,
  fields JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TRIGGER kvk_calculator_state_updated_at
  BEFORE UPDATE ON kvk_calculator_state
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE kvk_calculator_state ENABLE ROW LEVEL SECURITY;

-- 270680423 row 만 read/write. INSERT/UPDATE 시 새 row 의 kingshot_id 도 동일하게 강제.
CREATE POLICY "kvk_calculator_state_select" ON kvk_calculator_state
  FOR SELECT USING (kingshot_id = '270680423');

CREATE POLICY "kvk_calculator_state_insert" ON kvk_calculator_state
  FOR INSERT WITH CHECK (kingshot_id = '270680423');

CREATE POLICY "kvk_calculator_state_update" ON kvk_calculator_state
  FOR UPDATE
  USING (kingshot_id = '270680423')
  WITH CHECK (kingshot_id = '270680423');

-- ROLLBACK:
--   DROP TABLE IF EXISTS kvk_calculator_state;
