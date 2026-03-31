/**
 * turningWave.ts — 朱家泓《活用技術分析寶典》轉折波系統
 *
 * 書中 Part 2 (P21-32) 定義了系統化的轉折波取點法：
 * - 短線轉折波 (5日均線)
 * - 中線轉折波 (10日均線)
 * - 長線轉折波 (20日均線)
 *
 * 轉折波用途：
 * 1. 精確判斷趨勢方向 (頭頭高底底高 = 多頭)
 * 2. 定義停損位置 (轉折波低點)
 * 3. 盤整區域識別 (中波)
 */

import { CandleWithIndicators } from '@/types';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TurningPoint {
  idx: number;
  date: string;
  price: number;
  type: 'high' | 'low';
}

export interface WaveAnalysis {
  points: TurningPoint[];
  trend: 'bullish' | 'bearish' | 'sideways';
  /** 最近的轉折高點 */
  lastHigh: TurningPoint | null;
  /** 最近的轉折低點 */
  lastLow: TurningPoint | null;
  /** 停損參考位置（最近的轉折低點價格） */
  stopLossRef: number | null;
}

// ── Core Algorithm ─────────────────────────────────────────────────────────────

/**
 * 計算轉折波
 *
 * 算法（書中方法）：
 * - 以 MA(period) 為依據
 * - 股價在 MA 上方行進（正價群組），當跌破 MA 時，取正價群組 + 跌破當天的最高點
 * - 股價在 MA 下方行進（負價群組），當突破 MA 時，取負價群組 + 突破當天的最低點
 * - 連接高低點形成轉折波
 */
export function computeTurningWave(
  candles: CandleWithIndicators[],
  endIdx: number,
  period: 5 | 10 | 20 = 5,
): WaveAnalysis {
  const points: TurningPoint[] = [];
  const startIdx = Math.max(0, endIdx - 120); // 最多看120天

  // 取得 MA
  const getMA = (c: CandleWithIndicators): number | null => {
    if (period === 5) return c.ma5 ?? null;
    if (period === 10) return c.ma10 ?? null;
    return c.ma20 ?? null;
  };

  let _groupStart = startIdx;
  let aboveMA: boolean | null = null;
  let groupHighIdx = startIdx;
  let groupLowIdx = startIdx;

  for (let i = startIdx; i <= endIdx; i++) {
    const c = candles[i];
    const ma = getMA(c);
    if (ma == null) continue;

    const currentAbove = c.close > ma;

    // 初始化
    if (aboveMA === null) {
      aboveMA = currentAbove;
      _groupStart = i;
      groupHighIdx = i;
      groupLowIdx = i;
      continue;
    }

    // 更新群組最高/最低
    if (candles[i].high > candles[groupHighIdx].high) groupHighIdx = i;
    if (candles[i].low < candles[groupLowIdx].low) groupLowIdx = i;

    // 穿越 MA — 產生轉折點
    if (currentAbove !== aboveMA) {
      if (aboveMA) {
        // 正價群組結束（跌破MA）→ 取高點
        points.push({
          idx: groupHighIdx,
          date: candles[groupHighIdx].date,
          price: candles[groupHighIdx].high,
          type: 'high',
        });
      } else {
        // 負價群組結束（突破MA）→ 取低點
        points.push({
          idx: groupLowIdx,
          date: candles[groupLowIdx].date,
          price: candles[groupLowIdx].low,
          type: 'low',
        });
      }

      // 重置
      aboveMA = currentAbove;
      _groupStart = i;
      groupHighIdx = i;
      groupLowIdx = i;
    }
  }

  // 判斷趨勢
  const trend = determineTrend(points);

  // 找最近的高低點
  const highs = points.filter(p => p.type === 'high');
  const lows = points.filter(p => p.type === 'low');
  const lastHigh = highs.length > 0 ? highs[highs.length - 1] : null;
  const lastLow = lows.length > 0 ? lows[lows.length - 1] : null;

  return {
    points,
    trend,
    lastHigh,
    lastLow,
    stopLossRef: lastLow?.price ?? null,
  };
}

/**
 * 根據轉折點判斷趨勢
 *
 * 朱老師6字口訣：
 * - 多頭：頭頭高、底底高
 * - 空頭：頭頭低、底底低
 * - 盤整：其他
 */
function determineTrend(points: TurningPoint[]): 'bullish' | 'bearish' | 'sideways' {
  if (points.length < 4) return 'sideways';

  // 取最近4個轉折點
  const recent = points.slice(-4);
  const highs = recent.filter(p => p.type === 'high');
  const lows = recent.filter(p => p.type === 'low');

  if (highs.length < 2 || lows.length < 2) return 'sideways';

  const lastTwoHighs = highs.slice(-2);
  const lastTwoLows = lows.slice(-2);

  const headHigher = lastTwoHighs[1].price > lastTwoHighs[0].price;
  const bottomHigher = lastTwoLows[1].price > lastTwoLows[0].price;
  const headLower = lastTwoHighs[1].price < lastTwoHighs[0].price;
  const bottomLower = lastTwoLows[1].price < lastTwoLows[0].price;

  if (headHigher && bottomHigher) return 'bullish';
  if (headLower && bottomLower) return 'bearish';
  return 'sideways';
}

/**
 * 計算三週期轉折波分析
 */
export function computeMultiTimeframeTurningWaves(
  candles: CandleWithIndicators[],
  idx: number,
): {
  short: WaveAnalysis;
  medium: WaveAnalysis;
  long: WaveAnalysis;
  /** 三週期共識趨勢 */
  consensus: 'bullish' | 'bearish' | 'sideways';
} {
  const short = computeTurningWave(candles, idx, 5);
  const medium = computeTurningWave(candles, idx, 10);
  const long = computeTurningWave(candles, idx, 20);

  // 共識：三者一致最強，兩者一致次之
  const trends = [short.trend, medium.trend, long.trend];
  const bullCount = trends.filter(t => t === 'bullish').length;
  const bearCount = trends.filter(t => t === 'bearish').length;

  let consensus: 'bullish' | 'bearish' | 'sideways' = 'sideways';
  if (bullCount >= 2) consensus = 'bullish';
  else if (bearCount >= 2) consensus = 'bearish';

  return { short, medium, long, consensus };
}
