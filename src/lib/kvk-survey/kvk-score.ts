/**
 * KvK 이벤트 예상 점수 계산 — 상세 다이얼로그에서 사용.
 *
 * 1일차(건설):
 *   건설 가속권 1분 = 30 포인트. 모든 건설 가속권을 사용한다고 가정.
 *
 * 4일차(훈련):
 *   훈련 + 공용 가속권을 모두 병사 훈련에 사용. 티어별 effective 훈련시간/점수.
 *   - TC 26~29: 티어 9 (45 P/병, 기본 131초 → effective 45.17초)
 *   - TC 30+:   티어 10 (60 P/병, 기본 152초 → effective 52.41초)
 *
 * 가속 버프(190% = multiplier 2.9) 는 PLAN.md 기준 임시 고정값.
 * 5% 오차 — 게임 내 추가 변수(이벤트 보너스, 동맹 활동, 적용 타이밍) 흡수.
 *
 * 향후 변경 포인트:
 *   - 가속 버프 % 가 사용자 입력으로 바뀌면 SPEEDUP_MULTIPLIER 를 인자로 노출
 *   - 더 높은 티어 도입 시 TIERS 배열 확장
 */

export const KVK_SCORE_ERROR_RATE = 0.05;

/** 건설 가속권 1분당 점수 (1일차). */
const DAY1_POINT_PER_MINUTE = 30;

/** 총 가속 버프 — 190%. multiplier = 1 + 1.9 = 2.9. */
const SPEEDUP_MULTIPLIER = 2.9;

interface TierSpec {
  tier: 9 | 10;
  pointPerTroop: number;
  baseTrainSec: number;
}
const TIER_9: TierSpec = { tier: 9, pointPerTroop: 45, baseTrainSec: 131 };
const TIER_10: TierSpec = { tier: 10, pointPerTroop: 60, baseTrainSec: 152 };

/** city_level 기반 티어 선택. */
function tierFor(cityLevel: number): TierSpec {
  return cityLevel >= 30 ? TIER_10 : TIER_9;
}

export interface ScoreBand {
  /** 추정 점수 (중간값, 반올림). */
  value: number;
  /** -5% 하한 (반올림). */
  min: number;
  /** +5% 상한 (반올림). */
  max: number;
}

export interface KvKScoreEstimate {
  day1: ScoreBand;
  day4: ScoreBand & { tier: 9 | 10 };
}

export function estimateKvKScore(opts: {
  construction: number; // 분
  training: number;
  general: number;
  cityLevel: number;
}): KvKScoreEstimate {
  const spec = tierFor(opts.cityLevel);
  const effectiveTrainSec = spec.baseTrainSec / SPEEDUP_MULTIPLIER;

  // 1일차 — 건설 가속권 분 × 30 P
  const day1Raw = opts.construction * DAY1_POINT_PER_MINUTE;

  // 4일차 — (훈련+공용) 분 × 60 / effective_sec_per_troop × point_per_troop
  const totalSec = (opts.training + opts.general) * 60;
  const troops = totalSec / effectiveTrainSec;
  const day4Raw = troops * spec.pointPerTroop;

  return {
    day1: band(day1Raw),
    day4: { ...band(day4Raw), tier: spec.tier },
  };
}

function band(value: number): ScoreBand {
  return {
    value: Math.round(value),
    min: Math.round(value * (1 - KVK_SCORE_ERROR_RATE)),
    max: Math.round(value * (1 + KVK_SCORE_ERROR_RATE)),
  };
}
