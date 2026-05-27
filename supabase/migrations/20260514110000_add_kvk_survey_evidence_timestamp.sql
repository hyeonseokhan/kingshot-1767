-- KVK 설문 — 가속권 현황 인증샷 업로드 시점 추가
--
-- 설계 요약:
--   * Storage 는 기존 `blacklist-evidence` bucket 재사용. 하위 폴더 `kvk-survey/` 로 분리.
--   * 파일명 결정적: `kvk-survey/{kingshot_id}.webp` (1인 1장, upsert 만으로 갱신 → 고아 제로).
--   * URL 은 DB 에 저장하지 않음 — path 가 deterministic 이라 클라가 계산.
--   * 본 컬럼이 사실상 "인증 상태" 역할:
--       NULL          → 미인증 (이미지 없음)
--       TIMESTAMPTZ   → 인증됨 (= 마지막 업로드 시점). 캐시버스터 `?v={ms}` 로도 활용.
--   * 라이프사이클은 Edge Function 의 `set-evidence` 액션 + `delete` 가 책임.
--     register/update 자체는 가속권/시간만 다룸 → 이미지는 후속 호출로 분리.
--
-- ROLLBACK:
--   ALTER TABLE kvk_speedup_survey DROP COLUMN IF EXISTS evidence_uploaded_at;

ALTER TABLE kvk_speedup_survey
  ADD COLUMN IF NOT EXISTS evidence_uploaded_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN kvk_speedup_survey.evidence_uploaded_at IS
  '인증샷 마지막 업로드 시점. NULL=미인증. Storage path: kvk-survey/{kingshot_id}.webp (deterministic).';
