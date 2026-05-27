-- KVK 설문 세션 토큰
--
-- 매번 PIN 보내던 패턴 → 한 번 PIN verify 한 사용자가 token 으로 mutation.
-- 1인 1행이라 1 디바이스/토큰 가정 (새 로그인 시 기존 토큰 덮어쓰기 = 자동 회수).
-- 90일 만료 (자주 안 쓰는 사용자도 분기에 한 번은 재로그인).
--
-- Edge Function `kvk-survey` 의 신규/변경 action:
--   login (신규)       : kingshot_id + pin  → token + record
--   verify-token (신규): token              → record (boot 자동)
--   register (변경)    : pin + values       → token + record (insert)
--   update (변경)      : token (or pin)     → ok
--   delete (변경)      : token (or pin)     → ok
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_kvk_survey_session_token;
--   ALTER TABLE kvk_speedup_survey DROP COLUMN IF EXISTS session_expires_at;
--   ALTER TABLE kvk_speedup_survey DROP COLUMN IF EXISTS session_token;

ALTER TABLE kvk_speedup_survey
  ADD COLUMN IF NOT EXISTS session_token UUID,
  ADD COLUMN IF NOT EXISTS session_expires_at TIMESTAMPTZ;

-- verify-token 액션이 토큰으로 row 조회 → 단일 lookup 이라 partial index 가 효율적
-- (NULL token row 는 제외 → 인덱스 크기 작게 유지).
CREATE INDEX IF NOT EXISTS idx_kvk_survey_session_token
  ON kvk_speedup_survey (session_token)
  WHERE session_token IS NOT NULL;
