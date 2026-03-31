/**
 * highWinRateEntry.ts — 朱家泓《活用技術分析寶典》高勝率進場位置判斷
 *
 * 書中 Part 12 (P749-755) 定義了 6 個做多高勝率進場位置：
 * 1. 多頭打底確認 + 均線4線多排 + 突破MA5 + 大量 + 紅K(>2%)
 * 2. 回檔不破前低 + 4線多排 + 紅K(>2%) + 突破MA5 + 大量
 * 3. 突破盤整上頸線 + 4線多排 + 大量 + 紅K(>2%)
 * 4. 紅K突破均線3線或4線糾結(一字底) + 大量
 * 5. 強勢股回檔1-2天 + 續攻紅K + 大量 + 突破黑K高點
 * 6. 假跌破真上漲 + 紅K + 大量 + 突破盤整上頸線
 *
 * 每個位置的核心共通條件：
 * - 收盤確認（不看盤中）
 * - 紅K實體棒（漲幅 > 2%）
 * - 大量（量比 > 1.3x 5日均量）
 */

import { CandleWithIndicators } from '@/types';

/** 高勝率進場位置類型 */
export type HighWinRateEntryType =
  | 'bottomConfirm'     // 位置1: 多頭打底確認
  | 'pullbackBuy'       // 位置2: 回檔不破前低
  | 'necklineBreak'     // 位置3: 突破盤整上頸線
  | 'maClusterBreak'    // 位置4: 均線糾結突破
  | 'strongResume'      // 位置5: 強勢股回檔續攻
  | 'fakeBreakdown';    // 位置6: 假跌破真上漲

export interface HighWinRateResult {
  matched: boolean;
  types: HighWinRateEntryType[];
  score: number;        // 0-30 加分 (每個位置 +5)
  details: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** 紅K實體棒（漲幅 > 2%） */
function isStrongRedCandle(c: CandleWithIndicators): boolean {
  return c.close > c.open && ((c.close - c.open) / c.open) >= 0.02;
}

/** 大量：量比 > 1.3x 5日均量 */
function isHighVolume(c: CandleWithIndicators): boolean {
  return c.avgVol5 != null && c.avgVol5 > 0 && c.volume >= c.avgVol5 * 1.3;
}


/** 均線3線多排：MA5 > MA10 > MA20 */
function is3MABullish(c: CandleWithIndicators): boolean {
  const { ma5, ma10, ma20 } = c;
  return ma5 != null && ma10 != null && ma20 != null && ma5 > ma10 && ma10 > ma20;
}

/** 收盤突破 MA5 */
function closeAboveMA5(c: CandleWithIndicators): boolean {
  return c.ma5 != null && c.close > c.ma5;
}

/** 均線糾結：MA5/10/20 spread < threshold */
function isMAClustered(c: CandleWithIndicators, threshold = 0.025): boolean {
  const { ma5, ma10, ma20 } = c;
  if (ma5 == null || ma10 == null || ma20 == null) return false;
  const maxMA = Math.max(ma5, ma10, ma20);
  const minMA = Math.min(ma5, ma10, ma20);
  if (minMA <= 0) return false;
  return (maxMA - minMA) / minMA < threshold;
}

// ── Entry Position Detection ───────────────────────────────────────────────────

/**
 * 位置1: 多頭打底確認
 * 空頭低檔打底盤整突破，反轉多頭確認
 * 條件：均線4線多排 + 突破MA5 + 大量 + 紅K(>2%)
 * 補充：股價站上月線(MA20)且月線向上
 */
function checkBottomConfirm(
  candles: CandleWithIndicators[],
  idx: number,
): boolean {
  if (idx < 30) return false;
  const c = candles[idx];
  if (!isStrongRedCandle(c) || !isHighVolume(c) || !closeAboveMA5(c)) return false;
  if (!is3MABullish(c)) return false;

  // MA20 必須向上（月線上揚）
  const prevMA20 = candles[idx - 1]?.ma20;
  if (c.ma20 == null || prevMA20 == null || c.ma20 <= prevMA20) return false;

  // 股價站上月線
  if (c.close <= c.ma20) return false;

  // 過去 20 天有打底（盤整區域：高低差 < 15%）
  const lookback = candles.slice(Math.max(0, idx - 20), idx);
  if (lookback.length < 10) return false;
  const highs = lookback.map(x => x.high);
  const lows = lookback.map(x => x.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  if (rangeLow <= 0) return false;
  const rangeSpread = (rangeHigh - rangeLow) / rangeLow;
  // 盤整區域：高低差 < 15%
  return rangeSpread < 0.15;
}

/**
 * 位置2: 回檔不破前低買上漲
 * 多頭回檔修正不破前低，再出現帶量紅K上漲
 * 條件：4線多排 + 紅K(>2%) + 突破MA5 + 大量
 */
function checkPullbackBuy(
  candles: CandleWithIndicators[],
  idx: number,
): boolean {
  if (idx < 10) return false;
  const c = candles[idx];
  if (!isStrongRedCandle(c) || !isHighVolume(c) || !closeAboveMA5(c)) return false;
  if (!is3MABullish(c)) return false;

  // 前幾天有回檔（至少1天收黑）
  const recent5 = candles.slice(Math.max(0, idx - 5), idx);
  const hasBlack = recent5.some(x => x.close < x.open);
  if (!hasBlack) return false;

  // 回檔期間不破前低
  // 找前10天的起漲低點
  const lookback = candles.slice(Math.max(0, idx - 10), idx);
  const recentLow = Math.min(...lookback.map(x => x.low));
  const prevSwingLow = Math.min(...candles.slice(Math.max(0, idx - 20), Math.max(0, idx - 10)).map(x => x.low));

  // 回檔低點不破前波低點
  return prevSwingLow > 0 && recentLow >= prevSwingLow * 0.98;
}

/**
 * 位置3: 突破盤整上頸線
 * 盤整後大量紅K突破上頸線
 * 條件：4線多排 + 大量 + 紅K(>2%) + 突破前5日高點
 */
function checkNecklineBreak(
  candles: CandleWithIndicators[],
  idx: number,
): boolean {
  if (idx < 10) return false;
  const c = candles[idx];
  if (!isStrongRedCandle(c) || !isHighVolume(c)) return false;
  if (!is3MABullish(c)) return false;

  // 過去5-10天有橫盤（收盤價波動 < 5%）
  const lookback = candles.slice(Math.max(0, idx - 10), idx);
  if (lookback.length < 5) return false;
  const closes = lookback.map(x => x.close);
  const maxClose = Math.max(...closes);
  const minClose = Math.min(...closes);
  if (minClose <= 0) return false;
  const consolidation = (maxClose - minClose) / minClose;
  if (consolidation >= 0.08) return false; // 不算盤整

  // 突破盤整高點
  const neckline = Math.max(...lookback.map(x => x.high));
  return c.close > neckline;
}

/**
 * 位置4: 均線糾結突破 (一字底)
 * 紅K突破均線3線或4線糾結 + 大量
 */
function checkMAClusterBreak(
  candles: CandleWithIndicators[],
  idx: number,
): boolean {
  if (idx < 5) return false;
  const c = candles[idx];
  if (!isStrongRedCandle(c) || !isHighVolume(c)) return false;

  // 前一天均線糾結
  const prev = candles[idx - 1];
  if (!isMAClustered(prev)) return false;

  // 今天紅K突破所有均線
  const { ma5, ma10, ma20 } = c;
  if (ma5 == null || ma10 == null || ma20 == null) return false;
  return c.close > ma5 && c.close > ma10 && c.close > ma20;
}

/**
 * 位置5: 強勢股回檔1-2天續攻
 * 強勢股回檔1-2天後，出現續攻紅K + 大量 + 突破黑K高點
 */
function checkStrongResume(
  candles: CandleWithIndicators[],
  idx: number,
): boolean {
  if (idx < 5) return false;
  const c = candles[idx];
  if (!isStrongRedCandle(c) || !isHighVolume(c)) return false;
  if (!is3MABullish(c)) return false;

  // 前 1-2 天是回檔（黑K）
  const d1 = candles[idx - 1];
  const d2 = candles[idx - 2];
  const pullbackDays = [d1, d2].filter(x => x && x.close < x.open);
  if (pullbackDays.length === 0 || pullbackDays.length > 2) return false;

  // 回檔前是上漲趨勢（前3-5天有連續紅K）
  const prePullback = candles.slice(Math.max(0, idx - 5), idx - pullbackDays.length);
  const redCount = prePullback.filter(x => x.close > x.open).length;
  if (redCount < 2) return false;

  // 今天突破回檔黑K的高點
  const pullbackHighest = Math.max(...pullbackDays.map(x => x.high));
  return c.close > pullbackHighest;
}

/**
 * 位置6: 假跌破真上漲
 * 跌破盤整下頸線後，快速收回 + 紅K + 大量
 */
function checkFakeBreakdown(
  candles: CandleWithIndicators[],
  idx: number,
): boolean {
  if (idx < 10) return false;
  const c = candles[idx];
  if (!isStrongRedCandle(c) || !isHighVolume(c)) return false;

  // 過去10天有盤整
  const lookback = candles.slice(Math.max(0, idx - 10), idx);
  if (lookback.length < 5) return false;
  const closes = lookback.map(x => x.close);
  const minClose = Math.min(...closes);
  const _maxClose = Math.max(...closes);
  if (minClose <= 0) return false;

  // 前1-3天有跌破盤整低點
  const necklineLow = Math.min(...lookback.slice(0, -3).map(x => x.low));
  const recentLows = candles.slice(Math.max(0, idx - 3), idx);
  const brokeDown = recentLows.some(x => x.low < necklineLow);
  if (!brokeDown) return false;

  // 今天收回盤整上方
  return c.close > minClose;
}

// ── Main Evaluator ──────────────────────────────────────────────────────────────

/**
 * 評估一支股票是否符合朱老師 6 個高勝率做多位置
 * @param candles 帶指標的K線序列
 * @param idx     要評估的K線索引（通常是最後一根）
 * @returns 匹配結果，包含匹配的位置類型和加分
 */
export function evaluateHighWinRateEntry(
  candles: CandleWithIndicators[],
  idx: number,
): HighWinRateResult {
  const types: HighWinRateEntryType[] = [];
  const details: string[] = [];

  if (checkBottomConfirm(candles, idx)) {
    types.push('bottomConfirm');
    details.push('高勝率位置1: 多頭打底確認突破');
  }
  if (checkPullbackBuy(candles, idx)) {
    types.push('pullbackBuy');
    details.push('高勝率位置2: 回檔不破前低買上漲');
  }
  if (checkNecklineBreak(candles, idx)) {
    types.push('necklineBreak');
    details.push('高勝率位置3: 突破盤整上頸線');
  }
  if (checkMAClusterBreak(candles, idx)) {
    types.push('maClusterBreak');
    details.push('高勝率位置4: 均線糾結突破');
  }
  if (checkStrongResume(candles, idx)) {
    types.push('strongResume');
    details.push('高勝率位置5: 強勢股回檔續攻');
  }
  if (checkFakeBreakdown(candles, idx)) {
    types.push('fakeBreakdown');
    details.push('高勝率位置6: 假跌破真上漲');
  }

  // 每個匹配的位置加 5 分，最高 30 分
  const score = Math.min(types.length * 5, 30);

  return {
    matched: types.length > 0,
    types,
    score,
    details,
  };
}
