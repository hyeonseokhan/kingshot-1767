-- 메모 필드 사용 중지에 따른 컬럼 제거
ALTER TABLE members DROP COLUMN IF EXISTS memo;
