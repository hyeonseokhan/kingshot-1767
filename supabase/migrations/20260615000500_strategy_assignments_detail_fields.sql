-- strategy_assignments 상세보기 필드 추가
-- 상세보기 다이얼로그에 전투력·연맹 약어 표시를 위해 비정규화 저장.
-- (EF upsert-position 에서 함께 저장, swap-positions 에서 교환)

ALTER TABLE strategy_assignments
  ADD COLUMN IF NOT EXISTS power          BIGINT,
  ADD COLUMN IF NOT EXISTS alliance_abbr  TEXT;
