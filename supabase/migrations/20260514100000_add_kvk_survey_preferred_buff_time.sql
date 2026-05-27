-- KVK 설문 — 사용자 선호 버프 시작 시간 (UTC) 추가
--
-- 사용자가 가속 버프를 받고 싶은 UTC 시각을 30분 단위로 선택.
-- 예: '00:00', '00:30', ..., '23:30' — 48개 슬롯.
-- TEXT 형으로 저장 (가독성 + audit/sql 친화적). 미선택 시 NULL.
--
-- 검증은 Edge Function 에서 정규식으로 수행. CHECK 제약은 유연성 위해 부여.
-- 'HH:MM' (HH=00..23, MM=00 또는 30) 형식만 허용.
--
-- ROLLBACK (필요 시 수동):
--   ALTER TABLE kvk_speedup_survey DROP COLUMN IF EXISTS preferred_buff_time;

ALTER TABLE kvk_speedup_survey
  ADD COLUMN IF NOT EXISTS preferred_buff_time TEXT NULL
    CHECK (preferred_buff_time IS NULL OR preferred_buff_time ~ '^([01][0-9]|2[0-3]):(00|30)$');

COMMENT ON COLUMN kvk_speedup_survey.preferred_buff_time IS
  '사용자 선호 버프 시작 시간 (UTC). 30분 단위 ''HH:MM'' (예: ''14:30''). NULL=미선택.';
