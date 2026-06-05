/**
 * 캐슬 전투 — DB 스키마(cb_*) 와 매핑되는 TS 타입.
 * 마이그레이션: supabase/migrations/20260529000000_create_castle_battle.sql
 */

export type CbRoundStatus =
  | 'preparing'
  | 'voting'
  | 'voting_closed'
  | 'results_in'
  | 'archived';

export type CbTargetSlot =
  | 'castle'
  | 'turret_north'
  | 'turret_east'
  | 'turret_south'
  | 'turret_west';

/** 슬롯 표시명 (UI 라벨) — 동서남북 cardinal. */
export const SLOT_LABEL: Record<CbTargetSlot, string> = {
  castle: '캐슬',
  turret_north: '북쪽 포탑',
  turret_east: '동쪽 포탑',
  turret_south: '남쪽 포탑',
  turret_west: '서쪽 포탑',
};

/** 컴파스 SVG dot 좌표 (cx, cy in viewBox 0..24).
 *  cardinal 4 위치 (N=상, E=우, S=하, W=좌) + 중앙 캐슬.
 */
export const SLOT_COMPASS: Record<CbTargetSlot, { cx: number; cy: number }> = {
  castle: { cx: 12, cy: 12 },
  turret_north: { cx: 12, cy: 4 },
  turret_east: { cx: 20, cy: 12 },
  turret_south: { cx: 12, cy: 20 },
  turret_west: { cx: 4, cy: 12 },
};

/** 렌더링 순서 (좌→우) — 서/북/캐슬/동/남. */
export const SLOT_RENDER_ORDER: CbTargetSlot[] = [
  'turret_west',
  'turret_north',
  'castle',
  'turret_east',
  'turret_south',
];

export interface CbRound {
  id: number;
  title: string;
  event_starts_at: string;
  status: CbRoundStatus;
  memo: string | null;
  created_by: string;
  created_at: string;
  voting_opened_at: string | null;
  voting_closed_at: string | null;
  results_entered_at: string | null;
}

export interface CbTarget {
  id: number;
  round_id: number;
  slot: CbTargetSlot;
  is_open: boolean;
}

export interface CbAlliance {
  id: number;
  tag: string;
  name: string;
}

export interface CbCandidate {
  id: number;
  target_id: number;
  alliance_id: number;
  rallier_nickname: string;
  kingshot_id: string | null;
  display_order: number;
}

export interface CbVote {
  id: number;
  round_id: number;
  target_id: number;
  candidate_id: number;
  voter_kingshot_id: string;
  created_at: string;
}

export interface CbVoteCount {
  candidate_id: number;
  target_id: number;
  alliance_id: number;
  rallier_nickname: string;
  vote_count: number;
}

export interface CbResult {
  target_id: number;
  winning_candidate_id: number | null;
  entered_by: string;
  entered_at: string;
}

// ─── view-model 타입 (page 가 컴포넌트에 전달하는 형태) ─────────

/** 후보 + 연맹 + 표 정보가 join 된 형태. UI 가 직접 소비. */
export interface CandidateView {
  candidate_id: number;
  target_id: number;
  alliance_tag: string;
  alliance_name: string;
  rallier_nickname: string;
  kingshot_id: string | null;
  /** members.profile_photo (있으면 표시). */
  profile_photo: string | null;
  vote_count: number;
  /** target 내 점유율 (0..100). */
  vote_pct: number;
  /** 내가 이 후보에게 투표했나? */
  is_mine: boolean;
}

/** 거점 + 후보 리스트 묶음. card / dialog 가 소비. */
export interface TargetView {
  target_id: number;
  slot: CbTargetSlot;
  is_open: boolean;
  candidates: CandidateView[];
  total_votes: number;
  /** 1위 후보 (vote_count desc, 동률이면 display_order asc). is_open=false 면 null. */
  leader: CandidateView | null;
  /** 내가 이 거점에 투표한 candidate (있으면). */
  my_vote: CandidateView | null;
}

/** 투표자 1명 (voter chip 용). */
export interface VoterView {
  kingshot_id: string;
  nickname: string;
  profile_photo: string | null;
  is_me: boolean;
}
