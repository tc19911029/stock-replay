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
import { findPivots, detectTrend } from '@/lib/analysis/trendAnalysis';

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


/**
 * 均線 4 線多排：MA5 > MA10 > MA20 > MA60（書本 Part 12 p.749-752 原文）
 * 書本高勝率位置 1/2/3/5 都寫「均線 4 線多排」，比六條件（3 線）更嚴格。
 * 2026-04-20 修：原 is3MABullish 偏離書本，改為書本 4 線版。
 */
function is4MABullish(c: CandleWithIndicators): boolean {
  const { ma5, ma10, ma20, ma60 } = c;
  return ma5 != null && ma10 != null && ma20 != null && ma60 != null &&
    ma5 > ma10 && ma10 > ma20 && ma20 > ma60;
}

/** 收盤突破 MA5 */
function closeAboveMA5(c: CandleWithIndicators): boolean {
  return c.ma5 != null && c.close > c.ma5;
}

/**
 * 均線糾結：MA5/10/20 spread < threshold
 * 注：書本 p.299 寫「狹幅盤整 5-6 天」未量化均線糾結 %；
 *     網路朱家泓資料亦無具體數字。程式交易實務區間 1-3%，取上限 3%。
 */
function isMAClustered(c: CandleWithIndicators, threshold = 0.03): boolean {
  const { ma5, ma10, ma20 } = c;
  if (ma5 == null || ma10 == null || ma20 == null) return false;
  const maxMA = Math.max(ma5, ma10, ma20);
  const minMA = Math.min(ma5, ma10, ma20);
  if (minMA <= 0) return false;
  return (maxMA - minMA) / minMA < threshold;
}

// ── Flat Bottom (一字底) Detection ─────────────────────────────────────────────

/** 一字底偵測結果 */
interface FlatBottomResult {
  isFlatBottom: boolean;
  consolidationDays: number;
  detail: string;
}

/**
 * 策略 E：一字底型態偵測（均線糾結底）
 *
 * 2026-04-20 命名重整：原「F 一字底」改為「策略 E」。
 *
 * 朱家泓《抓住飆股》25種型態 #9：
 * 1. 底部盤整≥2個月(40天)，上下幅度很小
 * 2. 至少MA5/MA10/MA20糾結在一起
 * 3. 盤整期間量極少，突破後量才放大
 * 4. 等大量突破確認後再買進
 */
export function detectStrategyE(
  candles: CandleWithIndicators[],
  idx: number,
): FlatBottomResult | null {
  // 至少需要 60 根K線（40天盤整 + 20天前期參考）
  if (idx < 60) return null;
  const c = candles[idx];

  // ── 步驟1: 突破K線基本條件 ──
  if (!isStrongRedCandle(c)) return null;
  const { ma5, ma10, ma20 } = c;
  if (ma5 == null || ma10 == null || ma20 == null) return null;
  // 收盤必須突破所有均線
  if (c.close <= ma5 || c.close <= ma10 || c.close <= ma20) return null;

  // ── 步驟2: 往前掃描盤整區間 ──
  // 從 idx-1 往前，用滾動20天窗口檢查收盤價高低差 < 8%
  const MAX_LOOKBACK = 120;
  const MIN_CONSOLIDATION = 40;
  let consolStart = idx - 1; // 盤整起始索引（往前推）

  for (let i = idx - 1; i >= Math.max(1, idx - MAX_LOOKBACK); i--) {
    // 滾動窗口：從 i 往前看 20 天
    const windowStart = Math.max(0, i - 19);
    const window = candles.slice(windowStart, i + 1);
    if (window.length < 10) break;

    const closes = window.map(x => x.close);
    const maxC = Math.max(...closes);
    const minC = Math.min(...closes);
    if (minC <= 0) break;
    const spread = (maxC - minC) / minC;

    // 窄幅閾值 8%：朱家泓書+網路均無具體值（只寫「狹幅、很小」），8% 為實作自選
    if (spread >= 0.08) break;
    consolStart = i;
  }

  const consolidationDays = (idx - 1) - consolStart + 1;
  if (consolidationDays < MIN_CONSOLIDATION) return null;

  // ── 步驟3: 計算上下頸線 ──
  const consolCandles = candles.slice(consolStart, idx);
  const consolCloses = consolCandles.map(x => x.close);
  const necklineHigh = Math.max(...consolCloses);
  const necklineLow = Math.min(...consolCloses);

  // 收盤必須突破上頸線
  if (c.close <= necklineHigh) return null;

  // ── 步驟4: 均線糾結確認（盤整末段10天內至少5天糾結） ──
  const tailStart = Math.max(consolStart, idx - 10);
  const tailCandles = candles.slice(tailStart, idx);
  const clusteredCount = tailCandles.filter(x => isMAClustered(x)).length;
  if (clusteredCount < 5) return null;

  // ── 步驟5: 量縮確認 ──
  // 盤整期間平均量
  const consolVols = consolCandles.map(x => x.volume).filter(v => v > 0);
  if (consolVols.length === 0) return null;
  const consolAvgVol = consolVols.reduce((a, b) => a + b, 0) / consolVols.length;

  // 盤整前20天平均量（作為基準）
  const preStart = Math.max(0, consolStart - 20);
  const preCandles = candles.slice(preStart, consolStart);
  const preVols = preCandles.map(x => x.volume).filter(v => v > 0);
  if (preVols.length >= 5) {
    const preAvgVol = preVols.reduce((a, b) => a + b, 0) / preVols.length;
    // 盤整期量必須 < 前期的 60%
    // 量縮 60%：朱家泓書+網路均無具體值（只寫「極少、出奇的少」），60% 為實作自選
    if (preAvgVol > 0 && consolAvgVol >= preAvgVol * 0.6) return null;
  }

  // ── 步驟6: 突破量確認 ──
  // 突破日成交量 ≥ 盤整期平均量的 2 倍（爆量，對齊朱家泓「均線糾結突破=爆量」定義）
  // 出處：cmoney 朱家泓均線糾結突破三要素（整理+突破+爆量）+ YouTube #17
  if (consolAvgVol > 0 && c.volume < consolAvgVol * 2) return null;

  return {
    isFlatBottom: true,
    consolidationDays,
    detail: `一字底型態突破（盤整${consolidationDays}天+均線糾結+量縮→大量突破，頸線${necklineLow.toFixed(1)}~${necklineHigh.toFixed(1)}）`,
  };
}

/** @deprecated 2026-04-20 改名為 detectStrategyE，本 alias 提供過渡期相容；下次清理時移除 */
export const detectFlatBottom = detectStrategyE;

// ── Entry Position Detection ───────────────────────────────────────────────────

/**
 * 位置1: 多頭打底確認（書本 Part 12 p.749）
 * 書本原文 6 項：
 *   ① 多頭打底趨勢確認（頭頭高底底高）
 *   ② 均線 4 線多排
 *   ③ 收盤突破 MA5
 *   ④ 大量
 *   ⑤ 實體紅K（>2%）
 *   ⑥ 收盤確認位置
 */
function checkBottomConfirm(
  candles: CandleWithIndicators[],
  idx: number,
): boolean {
  if (idx < 30) return false;
  const c = candles[idx];
  // ③ 收盤突破 MA5 + ④ 大量 + ⑤ 實體紅K
  if (!isStrongRedCandle(c) || !isHighVolume(c) || !closeAboveMA5(c)) return false;
  // ② 均線 4 線多排
  if (!is4MABullish(c)) return false;
  // ① 頭頭高底底高（趨勢多頭）
  return detectTrend(candles, idx) === '多頭';
}

/**
 * 位置2: 回檔不破前低買上漲（書本 Part 12 p.749）
 * 書本原文 5 項：
 *   ① 多頭回檔不破前低（= 不破壞頭頭高底底高的底底高）
 *   ② 均線 4 線多排
 *   ③ 實體紅K（>2%）
 *   ④ 收盤突破 MA5
 *   ⑤ 大量
 */
function checkPullbackBuy(
  candles: CandleWithIndicators[],
  idx: number,
): boolean {
  if (idx < 10) return false;
  const c = candles[idx];
  // ③④⑤ 紅K + 突MA5 + 大量
  if (!isStrongRedCandle(c) || !isHighVolume(c) || !closeAboveMA5(c)) return false;
  // ② 4 線多排
  if (!is4MABullish(c)) return false;
  // ① 不破前低（findPivots 無底底低，0 容差）
  const pivots = findPivots(candles, idx - 1, 8);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 2);
  if (lows.length < 2) return true;
  const [latest, earlier] = lows;
  return latest.price >= earlier.price;
}

/**
 * 位置3: 突破盤整上頸線（書本 Part 12 p.750）
 * 書本：上頸線 = 兩個頭（high pivots）連成一條線
 * 條件：4線多排 + 大量 + 紅K(>2%) + 今日 close 突破「兩頭連線」在今日的延伸值
 */
function checkNecklineBreak(
  candles: CandleWithIndicators[],
  idx: number,
): boolean {
  if (idx < 10) return false;
  const c = candles[idx];
  if (!isStrongRedCandle(c) || !isHighVolume(c)) return false;
  if (!is4MABullish(c)) return false;

  // 書本定義：用 findPivots 找最近兩個頭（high pivots），兩點連線
  const pivots = findPivots(candles, idx - 1, 8);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  if (highs.length < 2) return false;

  const [latest, earlier] = highs;
  if (latest.index <= earlier.index) return false;
  // 上頸線斜率（可能下降/水平/略升）
  const slope = (latest.price - earlier.price) / (latest.index - earlier.index);
  const daysFromLatest = idx - latest.index;
  const necklinePrice = latest.price + slope * daysFromLatest;

  return c.close > necklinePrice;
}

/**
 * 位置4: 均線糾結突破（一字底）— 書本 Part 12 p.751
 * 書本原文：實體紅K棒收盤突破均線3線或4線糾結、大量的位置
 * 只要：紅K+大量+前日糾結+今日突破三線，不需要 40 天盤整。
 *
 * 40 天 + 8% 窄幅 + 60% 量縮是**《抓住飆股》F 策略獨立一字底**的要求，
 * 位置 4 屬於寶典 Part 12，書本沒要那麼嚴格。
 */
function checkMAClusterBreak(
  candles: CandleWithIndicators[],
  idx: number,
): boolean {
  if (idx < 5) return false;
  const c = candles[idx];
  // 實體紅K + 大量
  if (!isStrongRedCandle(c) || !isHighVolume(c)) return false;
  // 前日均線糾結（MA5/10/20 spread < 3% 實務值，書本未量化）
  const prev = candles[idx - 1];
  if (!isMAClustered(prev)) return false;
  // 今日收盤突破三線
  const { ma5, ma10, ma20 } = c;
  if (ma5 == null || ma10 == null || ma20 == null) return false;
  return c.close > ma5 && c.close > ma10 && c.close > ma20;
}

/**
 * 位置5: 強勢股回檔1-2天續攻（書本 Part 12 p.752，圖 12-1-6）
 * 書本 + 圖：
 *   ① 強勢股（4 線多排）
 *   ② 回檔 1-2 天黑K
 *   ③ 回檔黑K **也大量**（圖 12-1-6 明確標示）
 *   ④ 續攻紅K（實體>2%）
 *   ⑤ 續攻紅K **大量**
 *   ⑥ 收盤突破下跌黑K高點
 */
function checkStrongResume(
  candles: CandleWithIndicators[],
  idx: number,
): boolean {
  if (idx < 5) return false;
  const c = candles[idx];
  // ④⑤ 續攻紅K大量
  if (!isStrongRedCandle(c) || !isHighVolume(c)) return false;
  // ① 強勢股 = 4 線多排
  if (!is4MABullish(c)) return false;

  // ② 前 1-2 天黑K
  const d1 = candles[idx - 1];
  const d2 = candles[idx - 2];
  const pullbackDays = [d1, d2].filter(x => x && x.close < x.open);
  if (pullbackDays.length === 0 || pullbackDays.length > 2) return false;

  // ③ 黑K 也大量（圖 12-1-6 標示）
  const allBlackHighVol = pullbackDays.every(x => isHighVolume(x));
  if (!allBlackHighVol) return false;

  // ⑥ 突破下跌黑K高點
  const pullbackHighest = Math.max(...pullbackDays.map(x => x.high));
  return c.close > pullbackHighest;
}

/**
 * 位置6: 假跌破真上漲（書本 Part 12 p.753）
 * 書本：假跌破（黑K破下頸線=底底線）+ 真上漲紅K + 收盤「突破上頸線」+ 大量
 *
 * 書本定義（圖 12-1-7）：
 *   - 下頸線 = 兩個底（low pivots）連線
 *   - 上頸線 = 兩個頭（high pivots）連線
 *   - 假跌破 = 前 1-3 天 close/low 跌破下頸線（但快速收回）
 *   - 真上漲 = 今日紅K大量 + 收盤突破上頸線
 */
function checkFakeBreakdown(
  candles: CandleWithIndicators[],
  idx: number,
): boolean {
  if (idx < 10) return false;
  const c = candles[idx];
  if (!isStrongRedCandle(c) || !isHighVolume(c)) return false;

  // findPivots 找兩頭兩底
  const pivots = findPivots(candles, idx - 1, 8);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 2);
  if (highs.length < 2 || lows.length < 2) return false;

  const [latestHigh, earlierHigh] = highs;
  const [latestLow, earlierLow] = lows;

  // 上頸線 = 兩頭連線今日延伸值
  const hiSlope = (latestHigh.price - earlierHigh.price) / (latestHigh.index - earlierHigh.index);
  const upperNeckline = latestHigh.price + hiSlope * (idx - latestHigh.index);

  // 下頸線 = 兩底連線今日延伸值
  const loSlope = (latestLow.price - earlierLow.price) / (latestLow.index - earlierLow.index);
  const lowerNecklineToday = latestLow.price + loSlope * (idx - latestLow.index);

  // 前 1-3 天曾跌破下頸線（假跌破）
  let brokeBelow = false;
  for (let i = Math.max(0, idx - 3); i < idx; i++) {
    const k = candles[i];
    const lowerNecklineI = latestLow.price + loSlope * (i - latestLow.index);
    if (k.low < lowerNecklineI) { brokeBelow = true; break; }
  }
  if (!brokeBelow) return false;
  void lowerNecklineToday; // 今日不需再檢查下頸線（只要前 1-3 天跌破即可）

  // 今日收盤突破上頸線（真上漲）
  return c.close > upperNeckline;
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
