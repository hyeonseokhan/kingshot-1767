-- KvK 가속 설문에 IP / 국가 컬럼 추가
--   * 최초 등록 + 매 update 마다 덮어쓰기 (히스토리 X — 단일 행 단일 IP)
--   * 클라이언트는 IP 송수신 안 함. Edge Function (service_role) 이 헤더에서 추출 → 저장
--     - ip      : x-forwarded-for / cf-connecting-ip / x-real-ip 헤더 우선순위
--     - country : Cloudflare 가 자동 부착하는 cf-ipcountry (ISO 3166-1 alpha-2, 예: 'KR')
--   * RLS 정책 0개 유지 — anon 키로는 읽기/쓰기 모두 차단됨 (개인정보 보호)
--
-- ROLLBACK (필요 시 수동 실행):
-- ALTER TABLE kvk_speedup_survey DROP COLUMN IF EXISTS ip;
-- ALTER TABLE kvk_speedup_survey DROP COLUMN IF EXISTS country;

ALTER TABLE kvk_speedup_survey
  ADD COLUMN IF NOT EXISTS ip      TEXT,
  ADD COLUMN IF NOT EXISTS country TEXT;
