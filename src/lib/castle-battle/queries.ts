/**
 * 캐슬 전투 데이터 조회 (Supabase REST).
 *
 * 모두 anon 권한으로 동작 (cb_* 테이블이 SELECT 정책 허용 — 단, cb_admins 만 차단).
 * INSERT/UPDATE 는 Edge Function 경유 (PIN 검증 필요).
 *
 * 페이지 SSR 시점에 호출 — Astro frontmatter 에서 await.
 */

import { supabase } from '@/lib/shared/supabase';
import type {
  CandidateView,
  CbAlliance,
  CbCandidate,
  CbRound,
  CbTarget,
  CbVoteCount,
  TargetView,
  VoterView,
} from './types';

/**
 * 현재 active 회차 (status != archived). 동시 1개 보장 (부분 unique index).
 * null = 회차 미개최.
 */
export async function getActiveRound(): Promise<CbRound | null> {
  const { data, error } = await supabase
    .from('cb_rounds')
    .select('*')
    .neq('status', 'archived')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[castle-battle] getActiveRound', error);
    return null;
  }
  return data as CbRound | null;
}

/**
 * 회차의 거점 + 후보 + 표 집계 + (옵션) 사용자 투표 이력을
 * 한 묶음으로 가공해서 반환. card / dialog 가 직접 소비.
 *
 * @param roundId — cb_rounds.id
 * @param myKingshotId — 로그인 사용자 ID (없으면 my_vote / is_mine 미산출)
 */
export async function getTargetsWithCandidates(
  roundId: number,
  myKingshotId: string | null = null,
): Promise<TargetView[]> {
  // 1) 거점
  const { data: targets, error: tErr } = await supabase
    .from('cb_targets')
    .select('*')
    .eq('round_id', roundId);
  if (tErr || !targets) {
    console.error('[castle-battle] getTargets', tErr);
    return [];
  }
  if (targets.length === 0) return [];

  const targetIds = (targets as CbTarget[]).map((t) => t.id);

  // 2) 후보 (열린 거점에 한해. 자유전투 거점 후보 X)
  const openTargetIds = (targets as CbTarget[]).filter((t) => t.is_open).map((t) => t.id);
  const { data: cands } =
    openTargetIds.length > 0
      ? await supabase
          .from('cb_candidates')
          .select('*')
          .in('target_id', openTargetIds)
          .order('display_order')
      : { data: [] as CbCandidate[] };
  const candidates = (cands ?? []) as CbCandidate[];

  // 3) 연맹 마스터
  const allianceIds = Array.from(new Set(candidates.map((c) => c.alliance_id)));
  const { data: alls } =
    allianceIds.length > 0
      ? await supabase.from('cb_alliances').select('*').in('id', allianceIds)
      : { data: [] as CbAlliance[] };
  const allianceMap = new Map<number, CbAlliance>(
    ((alls ?? []) as CbAlliance[]).map((a) => [a.id, a]),
  );

  // 4) 표 집계 (view)
  const { data: counts } =
    openTargetIds.length > 0
      ? await supabase
          .from('cb_vote_counts')
          .select('*')
          .in('target_id', openTargetIds)
      : { data: [] as CbVoteCount[] };
  const countMap = new Map<number, number>(
    ((counts ?? []) as CbVoteCount[]).map((c) => [c.candidate_id, Number(c.vote_count)]),
  );

  // 5) 후보의 kingshot_id 가 1767 members 에 있으면 profile_photo 조회
  const candKsIds = Array.from(
    new Set(candidates.map((c) => c.kingshot_id).filter((k): k is string => !!k)),
  );
  const profileMap = await fetchProfilePhotos(candKsIds);

  // 6) 내 투표 이력 (있으면)
  const myCandIds = new Set<number>();
  if (myKingshotId) {
    const { data: myVotes } = await supabase
      .from('cb_votes')
      .select('candidate_id')
      .eq('voter_kingshot_id', myKingshotId)
      .eq('round_id', roundId);
    (myVotes ?? []).forEach((v: { candidate_id: number }) => myCandIds.add(v.candidate_id));
  }

  // ─── 가공: TargetView 배열 ────────────────────────────
  const byTarget = new Map<number, CbCandidate[]>();
  for (const c of candidates) {
    const arr = byTarget.get(c.target_id) ?? [];
    arr.push(c);
    byTarget.set(c.target_id, arr);
  }

  return (targets as CbTarget[]).map((t) => {
    const cands = byTarget.get(t.id) ?? [];
    const total = cands.reduce((s, c) => s + (countMap.get(c.id) ?? 0), 0);
    const cvs: CandidateView[] = cands.map((c) => {
      const a = allianceMap.get(c.alliance_id);
      const count = countMap.get(c.id) ?? 0;
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      return {
        candidate_id: c.id,
        target_id: t.id,
        alliance_tag: a?.tag ?? '?',
        alliance_name: a?.name ?? '',
        rallier_nickname: c.rallier_nickname,
        kingshot_id: c.kingshot_id,
        profile_photo: c.kingshot_id ? profileMap.get(c.kingshot_id) ?? null : null,
        vote_count: count,
        vote_pct: pct,
        is_mine: myCandIds.has(c.id),
      };
    });
    // leader: vote_count desc, tie-break by display_order asc (already sorted)
    const sortedByVotes = [...cvs].sort((a, b) => b.vote_count - a.vote_count);
    const leader = t.is_open && sortedByVotes.length > 0 ? sortedByVotes[0] : null;
    const my_vote = cvs.find((c) => c.is_mine) ?? null;
    return {
      target_id: t.id,
      slot: t.slot,
      is_open: t.is_open,
      candidates: cvs,
      total_votes: total,
      leader,
      my_vote,
    };
  });
}

/**
 * 특정 후보에 투표한 voter 목록 (members JOIN — nickname + profile_photo).
 * 다이얼로그의 후보 펼치기 시 lazy fetch.
 *
 * @param candidateId
 * @param myKingshotId 본인 표시용 (없으면 모두 is_me=false)
 */
export async function getVoters(
  candidateId: number,
  myKingshotId: string | null = null,
): Promise<VoterView[]> {
  // cb_votes 의 voter_kingshot_id 만 우선 받고, members 로 한 번에 lookup.
  const { data: votes, error } = await supabase
    .from('cb_votes')
    .select('voter_kingshot_id, created_at')
    .eq('candidate_id', candidateId)
    .order('created_at', { ascending: true });
  if (error || !votes) return [];
  const ksIds = (votes as Array<{ voter_kingshot_id: string }>).map((v) => v.voter_kingshot_id);
  if (ksIds.length === 0) return [];
  const profileMap = await fetchProfilePhotos(ksIds);
  const nicknameMap = await fetchNicknames(ksIds);
  return ksIds.map((id) => ({
    kingshot_id: id,
    nickname: nicknameMap.get(id) ?? '#' + id,
    profile_photo: profileMap.get(id) ?? null,
    is_me: !!myKingshotId && id === myKingshotId,
  }));
}

// ─── 내부 헬퍼 ─────────────────────────────────────────────

/** members 테이블에서 profile_photo 일괄 lookup. */
async function fetchProfilePhotos(kingshotIds: string[]): Promise<Map<string, string | null>> {
  if (kingshotIds.length === 0) return new Map();
  const { data } = await supabase
    .from('members')
    .select('kingshot_id, profile_photo')
    .in('kingshot_id', kingshotIds);
  return new Map(
    ((data ?? []) as Array<{ kingshot_id: string; profile_photo: string | null }>).map((r) => [
      r.kingshot_id,
      r.profile_photo,
    ]),
  );
}

/** members 테이블에서 nickname 일괄 lookup. */
async function fetchNicknames(kingshotIds: string[]): Promise<Map<string, string>> {
  if (kingshotIds.length === 0) return new Map();
  const { data } = await supabase
    .from('members')
    .select('kingshot_id, nickname')
    .in('kingshot_id', kingshotIds);
  return new Map(
    ((data ?? []) as Array<{ kingshot_id: string; nickname: string }>).map((r) => [
      r.kingshot_id,
      r.nickname,
    ]),
  );
}
