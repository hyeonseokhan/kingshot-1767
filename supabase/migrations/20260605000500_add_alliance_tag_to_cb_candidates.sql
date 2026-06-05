-- cb_candidates 에 alliance_tag 컬럼 추가.
--
-- 근거:
--   adminGetRoundDetail / adminAddCandidateFull EF 가 alliance_tag 를 직접
--   SELECT·INSERT 하는데 해당 컬럼이 없어 unexpected_error 발생.
--   JOIN 없이 조회 가능하도록 태그 스냅샷 컬럼을 추가하고 기존 행 backfill.
--
-- ROLLBACK:
--   ALTER TABLE cb_candidates DROP COLUMN IF EXISTS alliance_tag;

ALTER TABLE cb_candidates ADD COLUMN IF NOT EXISTS alliance_tag TEXT;

-- 기존 행 backfill: alliance_id → cb_alliances.tag
UPDATE cb_candidates c
SET alliance_tag = a.tag
FROM cb_alliances a
WHERE a.id = c.alliance_id
  AND c.alliance_tag IS NULL;
