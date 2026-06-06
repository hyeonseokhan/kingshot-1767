-- 집결자 프로필 캐시 테이블
--
-- 용도: 관리자가 집결자 등록 시 킹샷 ID 로 게임 API 조회 → 닉네임/아바타 스냅샷 저장.
--       cb_candidates.kingshot_id 가 있으면 이 테이블에서 프로필을 참조.
--       members 테이블과 달리 1767 서버 외 외부 연맹 집결자도 수용 (FK 없음).
--
-- 인덱스/RLS: anon SELECT 허용 (공개 데이터). INSERT/UPDATE 는 EF (service_role).
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS cb_ralliers;

CREATE TABLE cb_ralliers (
  kingshot_id TEXT PRIMARY KEY,
  nickname TEXT,
  profile_photo TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE cb_ralliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cb_ralliers_select" ON cb_ralliers FOR SELECT USING (true);
