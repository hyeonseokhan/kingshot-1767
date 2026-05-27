-- KVK survey 인증샷 storage bucket.
--
-- 1인 1장 결정적 파일명: {kingshot_id}.webp
--   → 같은 사용자가 재업로드 시 같은 path upsert → 고아 zero.
-- URL 은 DB 에 저장하지 않음 — path 가 deterministic 이라 클라가 계산.
--
-- 시간순상 evidence_timestamp 컬럼 추가 (20260514110000) 직전에 둠 — bucket 이 먼저 존재해야
-- 컬럼이 가리킬 곳이 생긴다는 인과 표현.
--
-- ROLLBACK:
--   DELETE FROM storage.objects WHERE bucket_id = 'survey-evidence';
--   DELETE FROM storage.buckets WHERE id = 'survey-evidence';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'survey-evidence',
  'survey-evidence',
  true,                                       -- 누구나 URL 로 읽기 가능 (URL 은 unguessable 한 v=timestamp 동봉)
  524288,                                     -- 단일 파일 max 512 KB (1080@q80 평균 ~100KB 의 5배 여유)
  ARRAY['image/webp']                         -- WebP 만 허용 — 클라가 변환해 올림
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage RLS — 모든 작업 anon 허용. 인증 가드는 클라 + Edge Function 의 set-evidence 가 담당.
CREATE POLICY "survey_evidence_select" ON storage.objects FOR SELECT
  USING (bucket_id = 'survey-evidence');
CREATE POLICY "survey_evidence_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'survey-evidence');
CREATE POLICY "survey_evidence_update" ON storage.objects FOR UPDATE
  USING (bucket_id = 'survey-evidence');
CREATE POLICY "survey_evidence_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'survey-evidence');
