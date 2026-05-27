-- 연맹원 인증 자격 (PIN) 테이블
--   * 미니게임 본인 인증용 4자리 PIN 의 해시 + salt 저장
--   * anon 키로는 접근 불가 (RLS 정책 0개) → Edge Function (service_role) 만 사용
CREATE TABLE IF NOT EXISTS member_credentials (
  player_id  TEXT PRIMARY KEY REFERENCES members(kingshot_id) ON DELETE CASCADE,
  pin_hash   TEXT NOT NULL,
  pin_salt   TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TRIGGER member_credentials_updated_at
  BEFORE UPDATE ON member_credentials
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- RLS 활성화 + 정책 0개 = anon 키로 select/insert/update/delete 모두 차단
-- service_role (Edge Function) 만 접근 가능
ALTER TABLE member_credentials ENABLE ROW LEVEL SECURITY;
