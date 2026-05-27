-- 설문 폼에서 [버프 시간] 입력이 더 이상 필요 없어 제거.
-- 데이터 사용처 0건 확인 후 컬럼 자체 drop. 추가한 마이그레이션:
--   20260514100000_add_kvk_survey_preferred_buff_time.sql
-- 클라/Edge Function 의 preferred_buff_time read/write 도 동일 PR 에서 제거.

ALTER TABLE kvk_speedup_survey DROP COLUMN IF EXISTS preferred_buff_time;

-- ROLLBACK:
--   ALTER TABLE kvk_speedup_survey
--     ADD COLUMN preferred_buff_time TEXT NULL
--     CHECK (preferred_buff_time IS NULL OR preferred_buff_time ~ '^([01][0-9]|2[0-3]):(00|30)$');
