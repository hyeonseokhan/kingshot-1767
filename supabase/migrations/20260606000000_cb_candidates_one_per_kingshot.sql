-- 같은 거점에 같은 사용자(kingshot_id) 중복 등록 차단.
--
-- 정책:
--   - 거점 내에서 같은 kingshot_id 는 1회만 후보 등록 가능.
--   - kingshot_id 가 NULL 인 외부 연맹 집결자(닉네임만 등록)는 unique 검사 제외 — 부분 unique index.
--   - 다른 거점에 같은 kingshot_id 가 후보로 들어가는 것은 허용 (1:N 카디널리티 룰).
--
-- 클라이언트 (addBtn) 가 1차 방어, 본 index 가 동시 등록 race 대비 최종 방어.
-- EF 의 try/catch 에서 'duplicate key' 메시지를 'duplicate_candidate' 로 마스킹 중.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS cb_candidates_one_per_target_per_kingshot;

CREATE UNIQUE INDEX cb_candidates_one_per_target_per_kingshot
  ON cb_candidates (target_id, kingshot_id)
  WHERE kingshot_id IS NOT NULL;
