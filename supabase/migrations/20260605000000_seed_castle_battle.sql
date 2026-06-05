-- 캐슬 전투 시드 데이터 (Phase 1 — 조회 화면 검증용 mockup 시드)
--
-- 1767 members 가 비어 있어 후보의 profile_photo lookup 이 안 되는 상황 해결.
-- PNX 상위 멤버 10명을 1767 members 로 복사 + 회차/거점/후보/표 시드.
-- 운영자(Toycode) 도 cb_admins 등록.
--
-- ROLLBACK (필요 시 수동):
--   DELETE FROM cb_votes WHERE round_id IN (SELECT id FROM cb_rounds WHERE title LIKE '2026-06-15%');
--   DELETE FROM cb_candidates WHERE target_id IN (SELECT id FROM cb_targets WHERE round_id IN (SELECT id FROM cb_rounds WHERE title LIKE '2026-06-15%'));
--   DELETE FROM cb_targets   WHERE round_id IN (SELECT id FROM cb_rounds WHERE title LIKE '2026-06-15%');
--   DELETE FROM cb_rounds    WHERE title LIKE '2026-06-15%';
--   DELETE FROM cb_admins;
--   DELETE FROM cb_alliances WHERE tag IN ('PNX','SOD','OFA','ZOO');
--   DELETE FROM members WHERE kingshot_id IN (...) -- 시드 ID 만 식별해서 삭제

-- ─── members 시드 (캐슬 후보 풀 10명, PNX 상위 멤버) ─────────
INSERT INTO members (kingshot_id, nickname, profile_photo) VALUES
  ('270680423', 'Toycode',       'https://got-global-avatar.akamaized.net/avatar/2026/06/03/jBxqkv_1780475303.png'),
  ('269042150', 'E_raducanu',    'https://got-global-avatar.akamaized.net/avatar/2026/05/27/vwNZ4V_1779854869.png'),
  ('272302196', 'SsungBi',       'https://got-global-avatar.akamaized.net/avatar/2026/05/29/0M557y_1780093992.png'),
  ('269320982', 'Gambler_Kasi',  'https://got-global-avatar.akamaized.net/avatar/2026/05/25/omDmwj_1779690229.png'),
  ('271598249', 'Fox_King',      'https://got-global-avatar.akamaized.net/avatar-dev/2023/07/17/1031.png'),
  ('270451325', 'dean',          'https://got-global-avatar.akamaized.net/avatar/2026/03/20/J1Jlvl_1774003206.png'),
  ('271811051', '힘들땐기대',     'https://got-global-avatar.akamaized.net/avatar/2026/04/07/wxOrQX_1775557413.png'),
  ('269156681', '༒ Toretto ༒',  'https://got-global-avatar.akamaized.net/avatar/2026/03/15/omDYlK_1773563662.png'),
  ('269828476', 'rella',         'https://got-global-avatar.akamaized.net/avatar/2026/05/29/5M6QVZ_1780048388.png'),
  ('269795636', 'Chrome',        'https://got-global-avatar.akamaized.net/avatar/2026/03/05/mkAZL0_1772723687.png')
ON CONFLICT (kingshot_id) DO NOTHING;

-- ─── 운영자 등록 ────────────────────────────────────────────
INSERT INTO cb_admins (kingshot_id, added_by, memo)
VALUES ('270680423', '270680423', 'Toycode — 초기 운영자 (자기 추가)')
ON CONFLICT (kingshot_id) DO NOTHING;

-- ─── 연맹 마스터 (mockup 4종) ───────────────────────────────
INSERT INTO cb_alliances (tag, name) VALUES
  ('PNX', 'Phoenix'),
  ('SOD', 'Sons of Death'),
  ('OFA', 'Order of Faith'),
  ('ZOO', 'Zoo Kingdom')
ON CONFLICT (tag) DO NOTHING;

-- ─── 회차 ────────────────────────────────────────────────
-- 동시 active 1개 제약: 이미 active 가 있으면 INSERT 스킵.
INSERT INTO cb_rounds (title, event_starts_at, status, created_by, voting_opened_at, voting_closed_at)
SELECT
  '2026-06-15 캐슬 전투 시뮬레이션',
  '2026-06-15 20:00:00+09'::timestamptz,
  'voting',
  '270680423',
  NOW(),
  NOW() + INTERVAL '7 days'                -- 마감까지 약 7일 (카운트다운 데모)
WHERE NOT EXISTS (SELECT 1 FROM cb_rounds WHERE status != 'archived');

-- ─── 거점 (5 슬롯) ───────────────────────────────────────
-- turret_7 만 자유전투 (is_open=false). 나머지 4개는 베팅 진행.
WITH r AS (SELECT id FROM cb_rounds WHERE status != 'archived' ORDER BY created_at DESC LIMIT 1)
INSERT INTO cb_targets (round_id, slot, is_open)
SELECT r.id, s.slot, s.slot != 'turret_7'
FROM r,
  (VALUES ('castle'), ('turret_11'), ('turret_2'), ('turret_5'), ('turret_7'))
    AS s(slot)
ON CONFLICT (round_id, slot) DO NOTHING;

-- ─── 후보 ────────────────────────────────────────────────
-- castle: 6명 (E_raducanu/SsungBi/Gambler_Kasi/Fox_King/dean/힘들땐기대)
-- turret_11: 2명 (Toretto, rella)
-- turret_2 : 3명 — PNX 가 같은 거점에 2명 등록(1:N 시연: E_raducanu + dean)
-- turret_5 : 2명 (SsungBi, Fox_King)
-- turret_7 : 자유전투 (후보 X)
WITH
  r AS (SELECT id FROM cb_rounds WHERE status != 'archived' ORDER BY created_at DESC LIMIT 1),
  tc AS (SELECT id FROM cb_targets WHERE round_id = (SELECT id FROM r) AND slot = 'castle'),
  t11 AS (SELECT id FROM cb_targets WHERE round_id = (SELECT id FROM r) AND slot = 'turret_11'),
  t2  AS (SELECT id FROM cb_targets WHERE round_id = (SELECT id FROM r) AND slot = 'turret_2'),
  t5  AS (SELECT id FROM cb_targets WHERE round_id = (SELECT id FROM r) AND slot = 'turret_5'),
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
  -- turret_11
  UNION ALL SELECT (SELECT id FROM t11), (SELECT id FROM ofa), '༒ Toretto ༒', '269156681', 1
  UNION ALL SELECT (SELECT id FROM t11), (SELECT id FROM zoo), 'rella',        '269828476', 2
  -- turret_2 (PNX 2명 1:N 시연)
  UNION ALL SELECT (SELECT id FROM t2), (SELECT id FROM pnx), 'E_raducanu', '269042150', 1
  UNION ALL SELECT (SELECT id FROM t2), (SELECT id FROM pnx), 'dean',       '270451325', 2
  UNION ALL SELECT (SELECT id FROM t2), (SELECT id FROM zoo), 'Chrome',     '269795636', 3
  -- turret_5
  UNION ALL SELECT (SELECT id FROM t5), (SELECT id FROM sod), 'SsungBi',  '272302196', 1
  UNION ALL SELECT (SELECT id FROM t5), (SELECT id FROM zoo), 'Fox_King', '271598249', 2
) AS rows
ON CONFLICT (target_id, alliance_id, rallier_nickname) DO NOTHING;

-- ─── 표 (vote_count 비율 — Toycode 가 캐슬 1위에게 투표 1건만 시드) ──
-- 풀 voter 시드는 다음 phase 에서 (지금은 카드 표시/1위 식별만 검증).
WITH
  r AS (SELECT id FROM cb_rounds WHERE status != 'archived' ORDER BY created_at DESC LIMIT 1),
  tc AS (SELECT id FROM cb_targets WHERE round_id = (SELECT id FROM r) AND slot = 'castle'),
  c1 AS (SELECT id FROM cb_candidates WHERE target_id = (SELECT id FROM tc) AND rallier_nickname = 'E_raducanu')
INSERT INTO cb_votes (round_id, target_id, candidate_id, voter_kingshot_id)
SELECT (SELECT id FROM r), (SELECT id FROM tc), (SELECT id FROM c1), '270680423'
ON CONFLICT (target_id, voter_kingshot_id) DO NOTHING;
