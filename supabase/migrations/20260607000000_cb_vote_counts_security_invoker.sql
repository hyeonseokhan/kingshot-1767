-- cb_vote_counts 뷰의 보안 컨텍스트를 INVOKER 로 전환.
--
-- 배경:
--   Supabase advisor 가 "view is defined with the SECURITY DEFINER property" 경고.
--   PG 의 view 는 기본적으로 정의자(DEFINER) 권한으로 underlying 테이블 접근 →
--   RLS 우회 위험. 호출자(INVOKER) 권한으로 바꿔 RLS 정책이 그대로 적용되도록 한다.
--
--   underlying 테이블 (cb_candidates, cb_votes) 은 anon SELECT 정책 보유 →
--   security_invoker = true 로 바꿔도 anon 조회 정상 동작.
--
-- PG 15+ 필요 (Supabase 는 PG 15+ 사용). PG 14 이하라면 DROP/CREATE 로 재정의 필요.
--
-- ROLLBACK:
--   ALTER VIEW cb_vote_counts SET (security_invoker = false);

ALTER VIEW cb_vote_counts SET (security_invoker = true);
