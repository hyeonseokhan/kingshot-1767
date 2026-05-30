-- 캐슬 전투 베팅 — 7 테이블 + 1 view
--
-- prefix: cb_ (castle battle). KvK 도메인(kvk_*)과 분리.
-- 인증: 기존 members + member_credentials + tile-match-auth EF 재사용 (신규 인증 테이블 없음).
-- 서버 번호(1767) 검증은 가입 시 공식 API 응답만 사용 (DB 컬럼 X).
--
-- 동시 active 회차 1개 보장: cb_rounds 부분 unique index.
-- 거점당 연맹 1개에서 집결자 N명 등록 가능 (cb_candidates 1:N).
-- 부분 투표 허용 (cb_votes row 없으면 미투표).
-- 투표는 거점×사용자 = 1 row (UNIQUE).
--
-- RLS: anon SELECT 만 허용. INSERT/UPDATE 는 Edge Function (service_role) 만.
-- cb_admins, cb_votes (INSERT) 는 anon 접근 차단.
--
-- ROLLBACK (필요 시 수동):
--   DROP VIEW IF EXISTS cb_vote_counts;
--   DROP TABLE IF EXISTS cb_results, cb_votes, cb_candidates,
--                        cb_targets, cb_admins, cb_alliances, cb_rounds CASCADE;

-- ─── 1. 회차 ───────────────────────────────────────────────
CREATE TABLE cb_rounds (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,                                    -- "2026-05-31 캐슬 전투"
  event_starts_at TIMESTAMPTZ NOT NULL,                   -- 게임 내 이벤트 시작 시각
  status TEXT NOT NULL DEFAULT 'preparing'
    CHECK (status IN ('preparing', 'voting', 'voting_closed', 'results_in', 'archived')),
  memo TEXT,
  created_by TEXT NOT NULL REFERENCES members(kingshot_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voting_opened_at TIMESTAMPTZ,
  voting_closed_at TIMESTAMPTZ,
  results_entered_at TIMESTAMPTZ
);

-- 동시 active 1개 보장: archived 가 아닌 회차는 동시에 1건만 가능
CREATE UNIQUE INDEX cb_rounds_only_one_active
  ON cb_rounds ((1))
  WHERE status != 'archived';

CREATE INDEX cb_rounds_status ON cb_rounds (status);

ALTER TABLE cb_rounds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cb_rounds_select" ON cb_rounds FOR SELECT USING (true);

-- ─── 2. 거점 (회차당 5개 슬롯 고정) ─────────────────────────
CREATE TABLE cb_targets (
  id BIGSERIAL PRIMARY KEY,
  round_id BIGINT NOT NULL REFERENCES cb_rounds(id) ON DELETE CASCADE,
  slot TEXT NOT NULL
    CHECK (slot IN ('castle', 'turret_11', 'turret_2', 'turret_5', 'turret_7')),
  is_open BOOLEAN NOT NULL DEFAULT TRUE,                  -- false = 자유전투 (베팅 X)
  UNIQUE (round_id, slot)
);

CREATE INDEX cb_targets_round ON cb_targets (round_id);

ALTER TABLE cb_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cb_targets_select" ON cb_targets FOR SELECT USING (true);

-- ─── 3. 연맹 마스터 ────────────────────────────────────────
CREATE TABLE cb_alliances (
  id BIGSERIAL PRIMARY KEY,
  tag TEXT NOT NULL UNIQUE,                               -- "PNX" 같은 약칭
  name TEXT NOT NULL,                                     -- 풀네임
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE cb_alliances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cb_alliances_select" ON cb_alliances FOR SELECT USING (true);

-- ─── 4. 집결자 후보 (1:N — 거점당 연맹 1개에서 N명) ────────
CREATE TABLE cb_candidates (
  id BIGSERIAL PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES cb_targets(id) ON DELETE CASCADE,
  alliance_id BIGINT NOT NULL REFERENCES cb_alliances(id),
  rallier_nickname TEXT NOT NULL,                         -- 등록 시점 닉네임 스냅샷
  kingshot_id TEXT,                                       -- nullable, FK 없음 (외부 연맹 허용)
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_id, alliance_id, rallier_nickname)
);

CREATE INDEX cb_candidates_target ON cb_candidates (target_id);

ALTER TABLE cb_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cb_candidates_select" ON cb_candidates FOR SELECT USING (true);

-- ─── 5. 사용자 투표 ────────────────────────────────────────
CREATE TABLE cb_votes (
  id BIGSERIAL PRIMARY KEY,
  round_id BIGINT NOT NULL REFERENCES cb_rounds(id) ON DELETE CASCADE,
  target_id BIGINT NOT NULL REFERENCES cb_targets(id) ON DELETE CASCADE,
  candidate_id BIGINT NOT NULL REFERENCES cb_candidates(id),
  voter_kingshot_id TEXT NOT NULL REFERENCES members(kingshot_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_id, voter_kingshot_id)                   -- 거점당 1인 1표
);

CREATE INDEX cb_votes_round ON cb_votes (round_id);
CREATE INDEX cb_votes_voter ON cb_votes (voter_kingshot_id);
CREATE INDEX cb_votes_target_candidate ON cb_votes (target_id, candidate_id);

ALTER TABLE cb_votes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cb_votes_select" ON cb_votes FOR SELECT USING (true);
-- INSERT/UPDATE/DELETE 정책 0개 = Edge Function (service_role) 만 접근

-- ─── 6. 게임 결과 (운영자 입력) ────────────────────────────
CREATE TABLE cb_results (
  target_id BIGINT PRIMARY KEY REFERENCES cb_targets(id) ON DELETE CASCADE,
  winning_candidate_id BIGINT REFERENCES cb_candidates(id),  -- nullable: 자유전투/결과 없음
  entered_by TEXT NOT NULL REFERENCES members(kingshot_id),
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE cb_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cb_results_select" ON cb_results FOR SELECT USING (true);

-- ─── 7. 운영자 화이트리스트 ────────────────────────────────
-- RLS 정책 0개 = anon 차단. 운영자 식별 노출 방지. service_role / Edge Function 만 접근.
CREATE TABLE cb_admins (
  kingshot_id TEXT PRIMARY KEY REFERENCES members(kingshot_id),
  added_by TEXT NOT NULL REFERENCES members(kingshot_id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  memo TEXT
);

ALTER TABLE cb_admins ENABLE ROW LEVEL SECURITY;
-- 의도적으로 SELECT 정책 없음 → anon 차단

-- ─── 집계 view (실시간) ────────────────────────────────────
CREATE VIEW cb_vote_counts AS
SELECT
  c.id AS candidate_id,
  c.target_id,
  c.alliance_id,
  c.rallier_nickname,
  COUNT(v.id) AS vote_count
FROM cb_candidates c
LEFT JOIN cb_votes v ON v.candidate_id = c.id
GROUP BY c.id, c.target_id, c.alliance_id, c.rallier_nickname;

-- view 는 underlying 테이블의 RLS 를 따름 (cb_candidates/cb_votes 둘 다 SELECT 허용)
