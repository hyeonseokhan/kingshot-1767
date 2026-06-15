-- 시나리오별 독립 그룹 분리
--
-- 기존: pre-attack / post-attack / counter (3개, 탭끼리 공유됨)
-- 변경: attack-pre / attack-post / attack-counter   → 공격 탭 전용
--       defense-counter                             → 수비 탭 전용
--       counter-pre / counter-post                  → 카운터 탭 전용

-- 1. 기존 CHECK 제약 제거
ALTER TABLE strategy_assignments
  DROP CONSTRAINT IF EXISTS strategy_assignments_group_id_check;

-- 2. 기존 그룹 이름 → 공격 탭 전용으로 변경
UPDATE strategy_assignments SET group_id = 'attack-pre'     WHERE group_id = 'pre-attack';
UPDATE strategy_assignments SET group_id = 'attack-post'    WHERE group_id = 'post-attack';
UPDATE strategy_assignments SET group_id = 'attack-counter' WHERE group_id = 'counter';

-- 3. 새 CHECK 제약 추가 (6개 그룹)
ALTER TABLE strategy_assignments
  ADD CONSTRAINT strategy_assignments_group_id_check
  CHECK (group_id IN (
    'attack-pre', 'attack-post', 'attack-counter',
    'defense-counter',
    'counter-pre', 'counter-post'
  ));

-- 4. 수비 탭 / 카운터 탭 전용 슬롯 신규 생성 (집결장 1 + 집결원 10)
DO $$
DECLARE
  grp  TEXT;
  i    INT;
  grps TEXT[] := ARRAY['defense-counter', 'counter-pre', 'counter-post'];
BEGIN
  FOREACH grp IN ARRAY grps LOOP
    INSERT INTO strategy_assignments (group_id, is_leader, display_order) VALUES (grp, true, 0);
    FOR i IN 1..10 LOOP
      INSERT INTO strategy_assignments (group_id, is_leader, display_order) VALUES (grp, false, i);
    END LOOP;
  END LOOP;
END;
$$;
