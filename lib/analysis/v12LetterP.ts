/**
 * v12 字母 P：高檔拉回（議題 5 拆出）
 *
 * 書本依據：寶典 Part 11-1 第 3 位置「等拉回」p.693
 *   「多頭連續上漲高檔，拉回不破前低，不破月線（MA20），再上漲時做多」
 *
 * 跟 B 回後買上漲的差別：
 * - B 等上漲（深回）：曾跌破 MA5 + 站回（回檔較深，已有結構性下跌）
 * - P 等拉回（淺回）：高檔回檔 1-2 天 + 不破 MA10（短時間小回）
 *
 * 議題 47/55/99：P 套 pivot gate（最近 1 pivot high + 1 pivot low）
 * 議題 64/89：紅 K 含漲停 + 跳空例外
 *
 * 軌道：long-trend
 * 類別：pullback（拉回類）
 */

import type { CandleWithIndicators } from '../../types';

import { detectTrend, findPivots } from './trendAnalysis';
import { isValidRedK } from './redKValidator';
import type { MarketId } from '../scanner/types';

export interface LetterPResult {
  triggered: boolean;
  triggerPrice?: number;        // 突破前 K 高
  bodyPct?: number;
  volumeRatio?: number;
  pullbackDays?: number;        // 拉回天數（1-2）
  prevSwingHigh?: number;       // 拉回前最高
  detail: string;
}

const MAX_PULLBACK_DAYS = 2;     // 淺回上限（議題 5「等拉回」≤ 2 天）
const MIN_PRIOR_RUN_PCT = 5;     // 拉回前需有過明顯上漲（≥ 5%）

/**
 * P 高檔拉回偵測
 *
 * 條件：
 * 1. 多頭趨勢（detectTrend = 多頭）
 * 2. 過去 N 天內有過上漲，最近 1-2 天回檔（淺回）
 * 3. 拉回最低點不破 MA10 / 不破前一個 pivot low
 * 4. 今日紅 K（含漲停/跳空例外）+ 實體 ≥ 2% + 量 ≥ 1.3×
 * 5. 收盤突破前一日（拉回最後一日）K 高
 */
export function detectLetterP(
  candles: CandleWithIndicators[],
  idx: number,
  market: MarketId = 'TW',
  symbol = '',
): LetterPResult {
  const empty: LetterPResult = { triggered: false, detail: 'P 高檔拉回未觸發' };

  if (idx < 21 || candles.length === 0) return empty;

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev || prev.volume <= 0 || c.open <= 0) return empty;

  // 1. 多頭趨勢（書本「多頭連續上漲」前提）
  if (detectTrend(candles, idx) !== '多頭') return empty;

  // 2. 紅 K（含漲停+跳空例外）+ 實體 ≥ 2%
  const prevPrev = candles[idx - 2];
  if (!prevPrev) return empty;
  const redKResult = isValidRedK(c, prevPrev.close, market, symbol);
  if (!redKResult) return empty;
  const bodyPct = ((c.close - c.open) / c.open) * 100;

  // 3. 量比 ≥ 1.3
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < 1.3) return empty;

  // 4. 過去 N 天內有過明顯上漲（≥ 5%）
  // 找拉回前最高（5-10 天內）
  let recentHigh = 0;
  let recentHighIdx = -1;
  const lookback = 10;
  for (let i = idx - 1; i >= Math.max(0, idx - lookback); i--) {
    if (candles[i].high > recentHigh) {
      recentHigh = candles[i].high;
      recentHighIdx = i;
    }
  }
  if (recentHighIdx < 0) return empty;

  // 拉回前 1-2 天才算淺回
  const pullbackDays = idx - recentHighIdx;
  if (pullbackDays < 1 || pullbackDays > MAX_PULLBACK_DAYS) return empty;

  // 5. 拉回前需有過上漲（pivot 低點到 recentHigh ≥ 5%）
  const pivots = findPivots(candles, idx, 8, false);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 2);
  if (lows.length === 0) return empty;
  const priorLow = lows[0].price;
  const priorRunPct = ((recentHigh - priorLow) / priorLow) * 100;
  if (priorRunPct < MIN_PRIOR_RUN_PCT) return empty;

  // 6. 拉回期間最低不破 MA10 / 不破前 pivot low
  let pullbackLow = c.low;
  for (let i = recentHighIdx; i <= idx; i++) {
    if (candles[i].low < pullbackLow) pullbackLow = candles[i].low;
  }
  if (c.ma10 != null && pullbackLow < c.ma10) return empty;
  if (pullbackLow < priorLow) return empty;

  // 7. 今日收盤突破前一日 K 高（書本「再上漲」 = 突破止跌 K 高點）
  if (c.close <= prev.high) return empty;

  return {
    triggered: true,
    triggerPrice: prev.high,
    bodyPct,
    volumeRatio,
    pullbackDays,
    prevSwingHigh: recentHigh,
    detail: `P 高檔拉回（多頭+${pullbackDays}天淺回不破MA10+紅K${bodyPct.toFixed(2)}%+量×${volumeRatio.toFixed(2)}+突破前K高${prev.high.toFixed(1)}）`,
  };
}
