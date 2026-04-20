/**
 * findBuyPoints — 對歷史 K 棒序列逐根判斷是否為買點（進場訊號）
 *
 * 對齊生產掃描 pipeline（見 `lib/backtest/optimizer/candidateCollector.ts`）：
 *   1. 六條件 `isCoreReady`（前 5 個必要條件全過）
 *   2. KD 向下禁止（K < 昨日 K）
 *   3. 長上影線禁止（上影 > 實體，書本定義）
 *   4. 十大戒律 `checkLongProhibitions` 不可為 prohibited
 *   5. R 淘汰法 `evaluateElimination` 不可為 eliminated
 *
 * 不含 MTF（長線保護），因 MTF 是面板 toggle 而非硬買點條件。
 * @see CLAUDE.md R10 選股邏輯單一事實
 */

import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { checkLongProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import type { CandleWithIndicators } from '@/types';

/** 找出 candles 裡所有符合生產掃描規則的買點 index 陣列（升序） */
export function findBuyPoints(candles: CandleWithIndicators[]): number[] {
  const thresholds = ZHU_V1.thresholds;
  const out: number[] = [];

  for (let i = 60; i < candles.length; i++) {
    const six = evaluateSixConditions(candles, i, thresholds);
    if (!six.isCoreReady) continue;

    const last = candles[i];
    const prev = candles[i - 1];

    if (last.kdK != null && prev?.kdK != null && last.kdK < prev.kdK) continue;

    // 長上影線禁止（書本定義：上影 > 實體 = 長上影 = 上方賣壓沉重）
    const bodyAbs = Math.abs(last.close - last.open);
    const upperShadowLen = last.high - Math.max(last.open, last.close);
    if (bodyAbs > 0 && upperShadowLen > bodyAbs) continue;

    if (checkLongProhibitions(candles, i).prohibited) continue;
    if (evaluateElimination(candles, i).eliminated) continue;

    out.push(i);
  }

  return out;
}

/** 二分搜：回傳 buyPoints 中 < currentIndex 的最大值，找不到回 null */
export function prevBuyPointIndex(buyPoints: readonly number[], currentIndex: number): number | null {
  let lo = 0, hi = buyPoints.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (buyPoints[mid] < currentIndex) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans === -1 ? null : buyPoints[ans];
}

/** 二分搜：回傳 buyPoints 中 > currentIndex 的最小值，找不到回 null */
export function nextBuyPointIndex(buyPoints: readonly number[], currentIndex: number): number | null {
  let lo = 0, hi = buyPoints.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (buyPoints[mid] > currentIndex) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
  }
  return ans === -1 ? null : buyPoints[ans];
}
