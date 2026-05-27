-- KvK 가속 설문에 platform 컬럼 추가
--   * sec-ch-ua-platform 헤더 raw 값 ("Android" | "iOS" | "Windows" | "macOS" | "Linux" 등)
--   * Chrome/Edge 계열만 부착 — Safari/Firefox 는 미상(NULL)
--   * Edge Function (service_role) 만 read/write. RLS 정책 0개 유지.
--
-- ROLLBACK (필요 시 수동 실행):
-- ALTER TABLE kvk_speedup_survey DROP COLUMN IF EXISTS platform;

ALTER TABLE kvk_speedup_survey
  ADD COLUMN IF NOT EXISTS platform TEXT;
