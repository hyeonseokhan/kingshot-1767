-- KVK 설문 — TC 레벨(센터 레벨) 게이트 도입
--
-- 등록 자격: city_level >= 26 (= TC 26 이상). 게임 공식 API 의 stove_lv 값 저장.
-- 목록 노출: Edge Function `list` 가 city_level >= 26 인 row 만 반환 (NULL 제외).
--
-- 기존 row (city_level NULL) 처리:
--   * 본 마이그레이션 시점엔 backfill 안 함 — 기존 등록자는 [등록/수정] 재진행 시
--     서버측 lookup 으로 latest city_level 채워짐.
--   * 목록에서 임시로 안 보이는 동안 사용자가 당황하지 않도록 클라이언트 상단에
--     "이전 등록자가 안 보이면 다시 등록하면 정상 표시" 안내문 노출.
--
-- 회귀 ROLLBACK:
--   ALTER TABLE kvk_speedup_survey DROP COLUMN city_level;

ALTER TABLE kvk_speedup_survey
  ADD COLUMN city_level SMALLINT NULL;

COMMENT ON COLUMN kvk_speedup_survey.city_level IS
  '센터 레벨 (stove_lv). 26 이상만 list 응답 포함. 기존 row 는 NULL — 재등록 시 채워짐.';
