/**
 * 전략 페이지 데이터 조회 — 빌드 타임 SSG 전용.
 * service_role 키 사용 → supabase-server 에서만 import.
 */
import { supabaseServer } from '@/lib/shared/supabase-server';
import type { StrategyGroup, StrategyMember } from './types';

const GROUP_DEFS: Pick<StrategyGroup, 'id' | 'label' | 'labelEn'>[] = [
  { id: 'pre-attack',  label: '캐슬 선 공격', labelEn: 'Pre-Castle Attack' },
  { id: 'post-attack', label: '캐슬 후 공격', labelEn: 'Post-Castle Attack' },
  { id: 'counter',     label: '카운터',       labelEn: 'Counter' },
];

/**
 * kvk_speedup_survey 에서 참가자를 가져와 3그룹으로 분배.
 * 분배 기준: city_level DESC 정렬 후 라운드로빈(index % 3) — 각 그룹 TC 수준 균등.
 */
export async function getStrategyGroups(): Promise<StrategyGroup[]> {
  const { data, error } = await supabaseServer
    .from('kvk_speedup_survey')
    .select('kingshot_id, nickname, avatar_url, city_level')
    .not('city_level', 'is', null)
    .gte('city_level', 26)
    .order('city_level', { ascending: false });

  const members = (error || !data ? [] : data) as StrategyMember[];

  const buckets: StrategyMember[][] = [[], [], []];
  members.forEach((m, i) => buckets[i % 3].push(m));

  return GROUP_DEFS.map((def, i) => ({ ...def, members: buckets[i] }));
}
