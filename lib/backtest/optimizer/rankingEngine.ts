/**
 * Ranking Engine — 排序引擎
 *
 * 排序因子：
 *   wH = 高勝率分數（highWinRateScore）
 *   wM = 0（MTF 只做篩選，不參與排序）
 */

import type { DailyCandidate, WeightCombo, RankedCandidate } from './types';

/**
 * 對單日的候選股進行排序
 */
export function rankCandidates(
  candidates:   DailyCandidate[],
  combo:        WeightCombo,
  mtfThreshold: number,
): RankedCandidate[] {
  // 1. Filter by MTF threshold
  const filtered = candidates.filter(c => c.mtfScore >= mtfThreshold);
  if (filtered.length === 0) return [];

  // 2. Per-day normalization
  const maxH = Math.max(1, ...filtered.map(c => c.highWinRateScore));

  // 3. Score, sort, assign rank
  const scored: RankedCandidate[] = filtered.map(c => ({
    ...c,
    finalScore: (c.highWinRateScore / maxH) * combo.wH,
    rank: 0,
  }));

  scored.sort((a, b) => b.finalScore - a.finalScore);
  for (let i = 0; i < scored.length; i++) {
    scored[i].rank = i + 1;
  }

  return scored;
}

// ── Predefined Weight Combos ────────────────────────────────────────────────────

/** Phase A: 單因子測試 */
export const SINGLE_FACTOR_COMBOS: WeightCombo[] = [
  { name: '純高勝率', wH: 1, wM: 0 },
];

/** Phase C: 權重網格搜索（wM 固定 0） */
export const GRID_COMBOS: WeightCombo[] = [
  { name: '1:1', wH: 1, wM: 0 },
];

/** MTF 門檻測試值 */
export const MTF_THRESHOLDS = [0, 1, 2, 3, 4];
