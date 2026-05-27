-- Track 6: 관리자 권한 컬럼 추가
--   is_admin = true 인 회원만 economy/admin-grant 호출 가능
--   외부에서 권한을 변경하는 인터페이스 없음 — DB SQL 마이그레이션으로만 부여/회수
--   현재 관리자: Toycode (kingshot_id=270680423)
ALTER TABLE members ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;

UPDATE members SET is_admin = true WHERE kingshot_id = '270680423';

-- ROLLBACK (필요 시 수동 실행):
-- ALTER TABLE members DROP COLUMN is_admin;
