-- 연맹원 관리 테이블
CREATE TABLE members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kingshot_id TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  level INTEGER DEFAULT 0,
  power BIGINT DEFAULT 0,
  kill_points BIGINT DEFAULT 0,
  alliance_role TEXT DEFAULT 'member',
  troop_count BIGINT DEFAULT 0,
  last_active_at TIMESTAMPTZ,
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 업데이트 시 updated_at 자동 갱신
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER members_updated_at
  BEFORE UPDATE ON members
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- RLS (Row Level Security) 활성화
ALTER TABLE members ENABLE ROW LEVEL SECURITY;

-- 누구나 조회 가능 (공개 가이드 사이트)
CREATE POLICY "members_select" ON members
  FOR SELECT USING (true);

-- anon 키로 삽입/수정/삭제 허용
CREATE POLICY "members_insert" ON members
  FOR INSERT WITH CHECK (true);

CREATE POLICY "members_update" ON members
  FOR UPDATE USING (true);

CREATE POLICY "members_delete" ON members
  FOR DELETE USING (true);
