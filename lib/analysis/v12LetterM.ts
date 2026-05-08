/**
 * v12 字母 M：突破上升軌道線
 *
 * 書本依據：
 * - 寶典 Part 5 切線篇 p.387「上升軌道線的畫法與實戰應用」⭐
 * - 寶典 Part 12-4 祕笈圖 18「突破上升軌道線大漲圖」p.~822
 *
 * 軌道線畫法（書本 p.387 原文）：
 *   「多頭上漲時，上升切線是一條連接 2 低點的趨勢線，
 *    在連接 2 低點中間的上面高點，畫 1 條與上升切線平行的上升線
 *    稱為「上升軌道線」，是一條壓力線」
 *
 * 條件：
 * 1. 多頭趨勢
 * 2. 找 2 個確認 pivot low（支撐切線）
 * 3. 過 2 低點之間最高 K high，畫平行於支撐切線的軌道線
 * 4. 收盤 ≥ 軌道線當日值 × 1.03（×3% 真突破）
 * 5. 紅 K + 實體 ≥ 2% + 量 ≥ 1.3×
 *
 * 議題 47：M 套 pivot gate（同 BP）
 * 議題 6：M 屬軌道類，套 ×3% 真突破
 *
 * 軌道：long-trend
 * 類別：channel
 */

import type { CandleWithIndicators } from '../../types';

import { detectTrend, findPivots } from './trendAnalysis';
import { isValidRedK } from './redKValidator';
import type { MarketId } from '../scanner/types';

export interface LetterMResult {
  triggered: boolean;
  /** 軌道線在今日的延伸值 */
  channelValue?: number;
  /** ×3% 真突破門檻 */
  breakoutThreshold?: number;
  /** 支撐切線：兩低點 */
  supportLow1Index?: number;
  supportLow1Price?: number;
  supportLow2Index?: number;
  supportLow2Price?: number;
  /** 軌道線：中間最高點 */
  channelAnchorIndex?: number;
  channelAnchorPrice?: number;
  bodyPct?: number;
  volumeRatio?: number;
  detail: string;
}

const MIN_PIVOT_GAP_DAYS = 5;   // 兩 pivot low 至少間隔 5 天（避免太接近）
const TRUE_BREAKOUT_PCT = 0.03; // 抓飆股 p.338 真突破 ×3%

/**
 * M 突破上升軌道線偵測
 */
export function detectLetterM(
  candles: CandleWithIndicators[],
  idx: number,
  market: MarketId = 'TW',
  symbol = '',
): LetterMResult {
  const empty: LetterMResult = { triggered: false, detail: 'M 突破軌道線未觸發' };

  if (idx < 30) return empty;

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev || prev.volume <= 0 || c.open <= 0) return empty;

  // 1. 多頭趨勢前提
  if (detectTrend(candles, idx) !== '多頭') return empty;

  // 2. 找 2 個確認 pivot low（依時間從新到舊）
  const pivots = findPivots(candles, idx, 10, false);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 2);
  if (lows.length < 2) return empty;

  // 兩 pivot low 至少間隔 5 天
  const [low1, low2] = lows; // low1 較新、low2 較舊
  if (low1.index - low2.index < MIN_PIVOT_GAP_DAYS) return empty;

  // 支撐切線斜率必須 > 0（多頭上升）
  if (low1.price <= low2.price) return empty;

  // 3. 找 2 低點之間最高 K（軌道線錨點）
  let anchorHigh = -Infinity;
  let anchorIdx = low2.index;
  for (let i = low2.index; i <= low1.index; i++) {
    if (candles[i].high > anchorHigh) {
      anchorHigh = candles[i].high;
      anchorIdx = i;
    }
  }

  // 4. 計算軌道線在今日的延伸值
  // 支撐切線斜率 m = (low1.price - low2.price) / (low1.index - low2.index)
  const slope = (low1.price - low2.price) / (low1.index - low2.index);
  // 軌道線過 anchor 點 + 平行
  // channelLine(t) = anchorHigh + slope * (t - anchorIdx)
  const channelToday = anchorHigh + slope * (idx - anchorIdx);

  // 5. ×3% 真突破：close ≥ channelToday × 1.03
  const breakoutThreshold = channelToday * (1 + TRUE_BREAKOUT_PCT);
  if (c.close < breakoutThreshold) return empty;

  // 6. 紅 K + 實體 ≥ 2%
  const prevPrev = candles[idx - 2];
  if (!prevPrev) return empty;
  if (!isValidRedK(c, prevPrev.close, market, symbol)) return empty;
  const bodyPct = ((c.close - c.open) / c.open) * 100;

  // 7. 量比 ≥ 1.3
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < 1.3) return empty;

  return {
    triggered: true,
    channelValue: channelToday,
    breakoutThreshold,
    supportLow1Index: low1.index,
    supportLow1Price: low1.price,
    supportLow2Index: low2.index,
    supportLow2Price: low2.price,
    channelAnchorIndex: anchorIdx,
    channelAnchorPrice: anchorHigh,
    bodyPct,
    volumeRatio,
    detail: `M 突破軌道線（軌道值 ${channelToday.toFixed(2)} ×3%=${breakoutThreshold.toFixed(2)}+紅K${bodyPct.toFixed(2)}%+量×${volumeRatio.toFixed(2)}）`,
  };
}
