-- 캐슬 전투 거점 슬롯 명을 시계 방향(11/2/5/7) → 동서남북(cardinal)로 변경.
-- mockup 디자인이 처음부터 동서남북 기반이었음. NEW_SERVICE.md 명세를 따랐던
-- 11/2/5/7 가 게임 메커니즘과 어긋났음.
--
-- 변경:
--   castle → castle
--   turret_11 → turret_west   (좌상 → 서)
--   turret_2  → turret_north  (상 → 북, 그리고 mockup 의 자유전투 위치)
--   turret_5  → turret_east   (우상/우하 → 동)
--   turret_7  → turret_south  (좌하 → 남)
--
-- 단, 위 맵핑은 임의 — 이전 시드 데이터의 의미는 보존 못함. 따라서 시드 데이터는
-- DELETE 후 재삽입 (cb_votes → cb_candidates → cb_targets 순으로 CASCADE 활용).
--
-- ROLLBACK:
--   DELETE FROM cb_votes; DELETE FROM cb_candidates; DELETE FROM cb_targets;
--   ALTER TABLE cb_targets DROP CONSTRAINT cb_targets_slot_check;
--   ALTER TABLE cb_targets ADD CONSTRAINT cb_targets_slot_check
--     CHECK (slot IN ('castle','turret_11','turret_2','turret_5','turret_7'));
--   -- 그리고 20260605000000 시드 재실행

-- 1) 기존 시드 데이터 정리 (cb_votes/cb_candidates는 cb_targets ON DELETE CASCADE 로 자동 삭제)
DELETE FROM cb_targets WHERE round_id IN (SELECT id FROM cb_rounds WHERE status != 'archived');

-- 2) CHECK 제약 교체
ALTER TABLE cb_targets DROP CONSTRAINT cb_targets_slot_check;
ALTER TABLE cb_targets ADD CONSTRAINT cb_targets_slot_check
  CHECK (slot IN ('castle', 'turret_north', 'turret_east', 'turret_south', 'turret_west'));

-- 3) 거점 재삽입 — 4 cardinal + 캐슬. turret_north 가 자유전투.
WITH r AS (SELECT id FROM cb_rounds WHERE status != 'archived' ORDER BY created_at DESC LIMIT 1)
INSERT INTO cb_targets (round_id, slot, is_open)
SELECT r.id, s.slot, s.slot != 'turret_north'
FROM r,
  (VALUES ('castle'), ('turret_north'), ('turret_east'), ('turret_south'), ('turret_west'))
    AS s(slot);

-- 4) 후보 재삽입 — mockup-vote 패턴 그대로:
--   castle  : 6명 (E_raducanu/SsungBi/Gambler_Kasi/Fox_King/dean/힘들땐기대)
--   west    : 2명 (Toretto/rella)
--   north   : 자유전투 (후보 X)
--   east    : 3명 — PNX 1:N (E_raducanu+dean) + Chrome
--   south   : 2명 (SsungBi/Fox_King)
WITH
  r AS (SELECT id FROM cb_rounds WHERE status != 'archived' ORDER BY created_at DESC LIMIT 1),
  tc AS (SELECT id FROM cb_targets WHERE round_id = (SELECT id FROM r) AND slot = 'castle'),
  tw AS (SELECT id FROM cb_targets WHERE round_id = (SELECT id FROM r) AND slot = 'turret_west'),
  te AS (SELECT id FROM cb_targets WHERE round_id = (SELECT id FROM r) AND slot = 'turret_east'),
  ts AS (SELECT id FROM cb_targets WHERE round_id = (SELECT id FROM r) AND slot = 'turret_south'),
  pnx AS (SELECT id FROM cb_alliances WHERE tag = 'PNX'),
  sod AS (SELECT id FROM cb_alliances WHERE tag = 'SOD'),
  ofa AS (SELECT id FROM cb_alliances WHERE tag = 'OFA'),
  zoo AS (SELECT id FROM cb_alliances WHERE tag = 'ZOO')
INSERT INTO cb_candidates (target_id, alliance_id, rallier_nickname, kingshot_id, display_order)
SELECT * FROM (
  -- castle
  SELECT (SELECT id FROM tc), (SELECT id FROM pnx), 'E_raducanu',    '269042150', 1
  UNION ALL SELECT (SELECT id FROM tc), (SELECT id FROM sod), 'SsungBi',       '272302196', 2
  UNION ALL SELECT (SELECT id FROM tc), (SELECT id FROM ofa), 'Gambler_Kasi',  '269320982', 3
  UNION ALL SELECT (SELECT id FROM tc), (SELECT id FROM zoo), 'Fox_King',      '271598249', 4
  UNION ALL SELECT (SELECT id FROM tc), (SELECT id FROM pnx), 'dean',          '270451325', 5
  UNION ALL SELECT (SELECT id FROM tc), (SELECT id FROM sod), '힘들땐기대',     '271811051', 6
  -- west
  UNION ALL SELECT (SELECT id FROM tw), (SELECT id FROM ofa), '༒ Toretto ༒', '269156681', 1
  UNION ALL SELECT (SELECT id FROM tw), (SELECT id FROM zoo), 'rella',        '269828476', 2
  -- east (PNX 2명 1:N 시연)
  UNION ALL SELECT (SELECT id FROM te), (SELECT id FROM pnx), 'E_raducanu', '269042150', 1
  UNION ALL SELECT (SELECT id FROM te), (SELECT id FROM pnx), 'dean',       '270451325', 2
  UNION ALL SELECT (SELECT id FROM te), (SELECT id FROM zoo), 'Chrome',     '269795636', 3
  -- south
  UNION ALL SELECT (SELECT id FROM ts), (SELECT id FROM sod), 'SsungBi',  '272302196', 1
  UNION ALL SELECT (SELECT id FROM ts), (SELECT id FROM zoo), 'Fox_King', '271598249', 2
) AS rows;

-- 5) 표 재삽입 — Toycode 가 캐슬 1위(E_raducanu)에게 투표
WITH
  r AS (SELECT id FROM cb_rounds WHERE status != 'archived' ORDER BY created_at DESC LIMIT 1),
  tc AS (SELECT id FROM cb_targets WHERE round_id = (SELECT id FROM r) AND slot = 'castle'),
  c1 AS (SELECT id FROM cb_candidates WHERE target_id = (SELECT id FROM tc) AND rallier_nickname = 'E_raducanu')
INSERT INTO cb_votes (round_id, target_id, candidate_id, voter_kingshot_id)
SELECT (SELECT id FROM r), (SELECT id FROM tc), (SELECT id FROM c1), '270680423';
