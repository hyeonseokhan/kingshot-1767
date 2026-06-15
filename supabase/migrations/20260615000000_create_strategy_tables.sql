-- KvK 전략 배정 테이블 + 관리자 테이블
--
-- strategy_assignments: 그룹(pre-attack / post-attack / counter) × 역할(집결장 / 집결원) 슬롯.
--   - is_leader=true  → 집결장 (그룹당 1명)
--   - is_leader=false → 집결원 (그룹당 최대 10명)
--   - kingshot_id/nickname/avatar_url/city_level: 배정된 사람. NULL = 빈 슬롯.
--   - display_order: 집결원 내 정렬 순서 (0부터)
--
-- strategy_admins: 배정 관리 권한을 가진 관리자. members 테이블과 FK.
--
-- RLS:
--   - 읽기: anon 허용 (뷰 레벨 인증은 클라이언트 + strategy Edge Function 에서)
--   - 쓰기: service_role(Edge Function) 전용

CREATE TABLE IF NOT EXISTS strategy_assignments (
  id            SERIAL PRIMARY KEY,
  group_id      TEXT NOT NULL CHECK (group_id IN ('pre-attack', 'post-attack', 'counter')),
  is_leader     BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INTEGER NOT NULL DEFAULT 0,
  kingshot_id   TEXT,
  nickname      TEXT,
  avatar_url    TEXT,
  city_level    SMALLINT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TRIGGER strategy_assignments_updated_at
  BEFORE UPDATE ON strategy_assignments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS strategy_admins (
  kingshot_id TEXT PRIMARY KEY REFERENCES members(kingshot_id) ON DELETE CASCADE
);

ALTER TABLE strategy_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_admins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "strategy_assignments_select" ON strategy_assignments
  FOR SELECT USING (true);

CREATE POLICY "strategy_admins_select" ON strategy_admins
  FOR SELECT USING (true);

-- 초기 빈 슬롯: 3그룹 × (집결장 1 + 집결원 10) = 33행
DO $$
DECLARE
  grp  TEXT;
  i    INT;
  grps TEXT[] := ARRAY['pre-attack', 'post-attack', 'counter'];
BEGIN
  FOREACH grp IN ARRAY grps LOOP
    INSERT INTO strategy_assignments (group_id, is_leader, display_order) VALUES (grp, true, 0);
    FOR i IN 1..10 LOOP
      INSERT INTO strategy_assignments (group_id, is_leader, display_order) VALUES (grp, false, i);
    END LOOP;
  END LOOP;
END;
$$;
