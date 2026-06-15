/** kvk_speedup_survey 에서 전략 페이지에 필요한 필드만 추출. */
export interface StrategyMember {
  kingshot_id: string;
  nickname: string;
  avatar_url: string | null;
  city_level: number | null;
}

export type StrategyGroupId = 'pre-attack' | 'post-attack' | 'counter';

export interface StrategyGroup {
  id: StrategyGroupId;
  label: string;
  labelEn: string;
  members: StrategyMember[];
}
