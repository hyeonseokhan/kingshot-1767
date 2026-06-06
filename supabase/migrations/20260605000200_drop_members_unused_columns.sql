-- members 테이블 미사용 컬럼 제거
-- 1767 서비스에서 실제로 사용하지 않는 게임 통계 컬럼 정리.
-- 인증/표시에 필요한 컬럼(kingshot_id, nickname, level, kingdom, profile_photo, is_admin)만 유지.
--
-- ROLLBACK:
--   ALTER TABLE members
--     ADD COLUMN power BIGINT DEFAULT 0,
--     ADD COLUMN kill_points BIGINT DEFAULT 0,
--     ADD COLUMN alliance_role TEXT DEFAULT 'member',
--     ADD COLUMN troop_count BIGINT DEFAULT 0,
--     ADD COLUMN last_active_at TIMESTAMPTZ,
--     ADD COLUMN alliance_rank TEXT DEFAULT 'R1';

ALTER TABLE members
  DROP COLUMN IF EXISTS power,
  DROP COLUMN IF EXISTS kill_points,
  DROP COLUMN IF EXISTS alliance_role,
  DROP COLUMN IF EXISTS troop_count,
  DROP COLUMN IF EXISTS last_active_at,
  DROP COLUMN IF EXISTS alliance_rank;
