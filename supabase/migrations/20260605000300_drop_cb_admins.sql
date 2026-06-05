-- cb_admins 테이블 제거 — members.is_admin 컬럼으로 통합.
--
-- 근거:
--   cb_admins 는 castle-battle EF 에서 관리자 여부 판정에 사용했으나,
--   members.is_admin 이 이미 같은 역할을 하며 pin-status 응답에도 포함됨.
--   중복 관리 지점을 제거하고 members.is_admin 단일 소스로 통일.
--
-- 이전에 cb_admins 에 있던 관리자는 members.is_admin = true 로 설정 필요.
-- (운영자가 직접 UPDATE members SET is_admin = true WHERE kingshot_id = '...' 실행)
--
-- ROLLBACK:
--   CREATE TABLE cb_admins (
--     kingshot_id TEXT PRIMARY KEY REFERENCES members(kingshot_id),
--     added_by TEXT NOT NULL REFERENCES members(kingshot_id),
--     added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--     memo TEXT
--   );
--   ALTER TABLE cb_admins ENABLE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS cb_admins;
