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

export type CbTargetSlot = 'castle' | 'turret_11' | 'turret_2' | 'turret_5' | 'turret_7';

/** 슬롯 표시명 (UI 라벨). 게임 내 시계 방향 표기. */
export const SLOT_LABEL: Record<CbTargetSlot, string> = {
  castle: '캐슬',
  turret_11: '11시 포탑',
  turret_2: '2시 포탑',
  turret_5: '5시 포탑',
  turret_7: '7시 포탑',
};

/** 컴파스 SVG 의 active dot 위치 (cx, cy in viewBox 0..24). */
export const SLOT_COMPASS: Record<CbTargetSlot, { cx: number; cy: number } | null> = {
  castle: { cx: 12, cy: 12 }, // center
  turret_11: { cx: 9, cy: 5 }, // 11시 방향
  turret_2: { cx: 19, cy: 6 }, // 2시
  turret_5: { cx: 19, cy: 18 }, // 5시
  turret_7: { cx: 5, cy: 18 }, // 7시
};

/** 렌더링 순서 (좌→우, 시계 방향). 캐슬 가운데. */
export const SLOT_RENDER_ORDER: CbTargetSlot[] = [
  'turret_7',
  'turret_11',
  'castle',
  'turret_2',
  'turret_5',
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
