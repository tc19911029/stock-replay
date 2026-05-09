/**
 * 高勝率進場 6 位置（書本 Part 12 p.749-754 + Part 2 相關章節）
 *
 * 書本明寫的 6 種做多高勝率位置（用戶 2026-04-21 從書本查證）：
 *   1. 多頭打底趨勢確認 — 均線4線多排、突破MA5、大量、紅K ≥2%（本檔 detectBottomTrendConfirmation）
 *   2. 回後買上漲       — 不破前低、突破MA5、大量、紅K（trendAnalysis.ts pulledBackBuy）
 *   3. 盤整突破         — 突破盤整上頸線、均線4線多排、大量、紅K（trendAnalysis.ts rangeBreakout）
 *   4. 均線糾結突破     — 突破3/4線糾結（一字底）、大量、紅K（本檔 detectMaClusterBreak）
 *   5. 強勢短回續攻     — 強勢股回檔1~2天、紅K大量突破前黑K高點（本檔 detectStrongPullbackResume）
 *   6. 假跌破反彈       — 假跌破真上漲、突破上頸線、大量、紅K（本檔 detectFalseBreakRebound）
 *
 * 本檔實作 1, 4, 5, 6 四個 detector；2-3 繼續留在 trendAnalysis.ts。
 *
 * 閾值來源：
 *   - 攻擊量 ≥ 前日 × 1.3（Part 7 p.488）
 *   - 糾結閾值 3%（書本沒明寫，取 max(MA5,10,20) 相對收盤差 <3%）
 *   - 假跌破窗口 5 天（書本「回檔跌破後很快站回」的「很快」具體化）
 */
import { CandleWithIndicators } from '@/types';
import { detectTrend, findPivots } from './trendAnalysis';

/**
 * 位置①：多頭打底趨勢確認（書本 Part 12 p.749-754 高勝率位置 1）
 * 書本：多頭打底趨勢確認、均線4線多排、收盤突破MA5、大量、實體紅K棒（漲幅大於2%）
 *
 * 與位置②「回後買上漲」的區別：
 *   位置① = 剛從底部結束空頭 / 盤整，近期曾跌破MA20，是多頭的「第一次」確認
 *   位置② = 已在多頭中的短暫回檔，收盤跌破MA5後站回
 */
export function detectBottomTrendConfirmation(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 20) return false;
  const c    = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev) return false;

  // 多頭趨勢（頭頭高底底高）確認
  const trend = detectTrend(candles, index);
  if (trend !== '多頭') return false;

  // 均線4線多排
  if (!c.ma5 || !c.ma10 || !c.ma20 || !c.ma60) return false;
  if (!(c.ma5 > c.ma10 && c.ma10 > c.ma20 && c.ma20 > c.ma60)) return false;

  // 昨日收盤 < MA5（剛從底部回升），今日突破MA5
  if (!prev.ma5 || prev.close >= prev.ma5) return false;
  if (c.close < c.ma5) return false;

  // 實體紅K ≥ 2%
  if (c.close <= c.open) return false;
  const bodyPct = c.open > 0 ? (c.close - c.open) / c.open : 0;
  if (bodyPct < 0.02) return false;

  // 大量 ≥ 前日 × 1.3
  if (prev.volume <= 0 || c.volume < prev.volume * 1.3) return false;

  return true;
}

/**
 * 位置⑤：強勢短回續攻（書本 Part 12 p.749-754 高勝率位置 5）
 * 書本：強勢股回檔1～2天後，出現強勢續攻的實體紅K棒、大量、收盤突破下跌黑K高點
 *
 * 與位置②「回後買上漲」的區別：
 *   位置⑤ = 強勢多頭股僅回檔1~2根黑K，今日突破黑K高點（不需跌破MA5）
 *   位置② = 回檔至收盤 < MA5，今日站回MA5
 */
export function detectStrongPullbackResume(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 3) return false;
  const c    = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev) return false;

  // 強勢股 = 多頭趨勢
  const trend = detectTrend(candles, index);
  if (trend !== '多頭') return false;

  // 今日：實體紅K ≥ 2% + 大量 ≥ 前日 × 1.3
  if (c.close <= c.open) return false;
  const bodyPct = c.open > 0 ? (c.close - c.open) / c.open : 0;
  if (bodyPct < 0.02) return false;
  if (prev.volume <= 0 || c.volume < prev.volume * 1.3) return false;

  // 找過去 1~2 日的「下跌黑K」，取其最高點
  const prev2 = index >= 2 ? candles[index - 2] : null;
  const prev3 = index >= 3 ? candles[index - 3] : null;
  let blackKHigh: number | null = null;

  if (prev.close < prev.open) {
    // 1 日回檔（前一根是黑K）
    blackKHigh = prev.high;
    if (prev2 && prev2.close < prev2.open) {
      // 2 日都是黑K，取較高的 high
      blackKHigh = Math.max(blackKHigh, prev2.high);
      // 若前3根全是黑K → 修正超過 2 天，不是「短回」
      if (prev3 && prev3.close < prev3.open) return false;
    }
  } else if (prev2 && prev2.close < prev2.open) {
    // 2 日前是黑K，昨日小幅回升（仍在回檔範圍）
    blackKHigh = prev2.high;
  } else {
    return false; // 近 2 日沒有黑K = 非短回型態
  }

  // 今日收盤突破黑K高點
  return c.close > blackKHigh;
}

/**
 * 打底第 1 支腳（Part 2 p.42-45 + Part 7 p.513）
 * 書本：空頭下跌到低檔，出現爆大量（5 日均量×2）的黑K或止跌紅K → 搶反彈進貨量
 * 注意：此函式保留供獨立使用，但不再列入高勝率 6 位置 tag（用戶 2026-04-21 確認）
 */
export function detectDoubleBottomLeg1(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 30) return false;
  const c = candles[index];

  // 空頭趨勢中
  const trend = detectTrend(candles, index);
  if (trend !== '空頭') return false;

  // 當日爆大量（5 日均量 × 2，書本 Part 7 p.487 爆大量定義）
  const avgVol5 = c.avgVol5;
  if (!avgVol5 || avgVol5 <= 0) return false;
  if (c.volume < avgVol5 * 2) return false;

  // 止跌訊號：紅K 或 長下影黑K
  const isRedK = c.close > c.open;
  const bodyAbs = Math.abs(c.close - c.open);
  const lowerShadow = Math.min(c.open, c.close) - c.low;
  return isRedK || lowerShadow > bodyAbs;
}

/**
 * 打底第 2 支腳 / 黃金右腳（Part 2 p.45 + Part 7 p.515）
 * 書本：已有第 1 腳 + 反彈遇壓回檔不破第 1 腳低點 + 大量紅K 上漲
 */
export function detectDoubleBottomLeg2(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 30) return false;
  const c = candles[index];

  // 當日紅K 實體 ≥2%
  if (c.close <= c.open) return false;
  const bodyPct = c.open > 0 ? (c.close - c.open) / c.open : 0;
  if (bodyPct < 0.02) return false;

  // 當日攻擊量（≥ 前日 × 1.3）
  const prev = candles[index - 1];
  if (!prev || prev.volume <= 0) return false;
  if (c.volume < prev.volume * 1.3) return false;

  // 過去 30 天內找第 1 腳（爆量低點）
  let leg1Low: number | null = null;
  for (let j = index - 30; j <= index - 5; j++) {
    if (j < 0) continue;
    const past = candles[j];
    if (!past?.avgVol5 || past.avgVol5 <= 0) continue;
    if (past.volume >= past.avgVol5 * 2 && past.low > 0) {
      if (leg1Low === null || past.low < leg1Low) leg1Low = past.low;
    }
  }
  if (leg1Low === null) return false;

  // 當日 low 不破第 1 腳低點（底底高）
  return c.low > leg1Low;
}

/**
 * 均線糾結突破（Part 4 p.299-303）
 * 書本：3 條均線聚合盤整 → 當日大量紅K 突破
 * 糾結閾值：(max(MA5,10,20) - min) / close < 3%（書本沒明寫具體%，此為合理實作）
 */
export function detectMaClusterBreak(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  const c = candles[index];
  if (c.ma5 == null || c.ma10 == null || c.ma20 == null || c.close <= 0) return false;

  // 當日三線聚合
  const maMax = Math.max(c.ma5, c.ma10, c.ma20);
  const maMin = Math.min(c.ma5, c.ma10, c.ma20);
  if ((maMax - maMin) / c.close >= 0.03) return false;

  // 過去 5 天也聚合（確認是盤整糾結，不是瞬間交叉）
  if (index < 5) return false;
  const prev5 = candles[index - 5];
  if (!prev5?.ma5 || !prev5?.ma10 || !prev5?.ma20 || prev5.close <= 0) return false;
  const prevSpread =
    (Math.max(prev5.ma5, prev5.ma10, prev5.ma20) -
      Math.min(prev5.ma5, prev5.ma10, prev5.ma20)) / prev5.close;
  if (prevSpread >= 0.03) return false;

  // 當日紅K 實體 ≥2%
  if (c.close <= c.open) return false;
  const bodyPct = (c.close - c.open) / c.open;
  if (bodyPct < 0.02) return false;

  // 當日攻擊量（≥ 5 日均量 × 1.3）
  const avgVol5 = c.avgVol5;
  if (!avgVol5 || c.volume < avgVol5 * 1.3) return false;

  // 收盤突破糾結帶上緣
  return c.close > maMax;
}

/**
 * 假跌破真上漲（書本圖表 12-1-7 進場做多型態⑥ + Part 4 葛蘭碧買點③ p.308-309）
 *
 * 書本嚴格版（2026-04-21 用戶授權 C 方案）：
 *   1. 前置結構 = 頭底頭底（至少 2 頭 + 2 底 pivots）→ 上下頸線
 *   2. 過去 5 日內出現一根「黑K + 量 ≥ 1.3× + 收盤跌破該日下頸線」= 假跌破
 *   3. 今日「紅K + 實體 ≥ 2% + 量 ≥ 1.3× + 收盤突破上頸線」= 真上漲
 *
 * 假跌破日算頸線時用該日之前的 pivots（避免 pivot 被假跌破本身污染）
 */
export function detectFalseBreakRebound(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 6) return false;
  const c = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev) return false;

  // 今日真上漲檢查
  const isRedK = c.close > c.open;
  if (!isRedK) return false;
  const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  if (bodyPct < 0.02) return false;
  const todayVolRatio = prev.volume > 0 ? c.volume / prev.volume : 0;
  if (todayVolRatio < 1.3) return false;

  // 今日上頸線（用截至今日 pivots 的最近兩頭連線）
  const allPivots = findPivots(candles, index, 10);
  const topHighs = allPivots.filter(p => p.type === 'high').slice(0, 2);
  if (topHighs.length < 2) return false;
  const hNew = topHighs[0], hOld = topHighs[1];
  const upperAt = (i: number): number => {
    if (hNew.index === hOld.index) return hOld.price;
    return hOld.price + (hNew.price - hOld.price) * (i - hOld.index) / (hNew.index - hOld.index);
  };
  if (c.close <= upperAt(index)) return false;

  // 過去 5 日找假跌破（黑K + 大量 + 收盤跌破當日下頸線）
  for (let i = Math.max(1, index - 5); i < index; i++) {
    const b = candles[i];
    const bPrev = candles[i - 1];
    if (!b || !bPrev) continue;
    const isBlackK = b.close < b.open;
    if (!isBlackK) continue;
    const bVolRatio = bPrev.volume > 0 ? b.volume / bPrev.volume : 0;
    if (bVolRatio < 1.3) continue;

    // 用 i-1 之前的 pivots 算下頸線，避免假跌破本身污染 pivot
    const pivotsBefore = findPivots(candles, i - 1, 10);
    const lowsBefore = pivotsBefore.filter(p => p.type === 'low').slice(0, 2);
    if (lowsBefore.length < 2) continue;
    const lNew = lowsBefore[0], lOld = lowsBefore[1];
    const lowerAtI = lNew.index === lOld.index
      ? lOld.price
      : lOld.price + (lNew.price - lOld.price) * (i - lOld.index) / (lNew.index - lOld.index);

    if (b.close < lowerAtI) return true;
  }
  return false;
}

/**
 * 回後買上漲完整 detector — B 買法 + ③ 高勝率位置 2 共用
 *
 * 書本依據：寶典 p.37 多頭趨勢進場 2 大口訣 ①
 *   「上漲一波後回檔不破前低 + 帶量中長紅 K + 收盤突破 MA5 + 突破前一日最高」
 *
 * 7 條 gate（全部必滿足，2026-05-09 補回書本明寫的「不破前低」+ 統一 detector）：
 *   1. 多頭趨勢（detectTrend === '多頭'）
 *   2. 昨日 close < MA5（昨日仍在 MA5 之下，回檔中）
 *   3. 今日 close > MA5（今日剛站回 MA5，止跌反攻）
 *   4. 不破前低：今日 low ≥ findPivots confirmed lows[0].price
 *   5. 紅 K 實體 ≥ 2%（寶典 SOP p.55 ⑤）
 *   6. 量 ≥ 前日 × 1.3（寶典 p.488 攻擊量）
 *   7. 收盤 > 前一日 high（突破前一日最高）
 */
export interface PullbackBuyResult {
  prevSwingLow: number;     // 前低（停損參考）
  pullbackDays: number;     // 回檔天數（info）
  bodyPct: number;          // 紅 K 實體 %
  volumeRatio: number;      // 量比
  breakoutPrice: number;    // 前一日 high（被突破）
}

export function detectPullbackBuy(
  candles: CandleWithIndicators[],
  index: number,
): PullbackBuyResult | null {
  if (index < 21) return null;

  const c = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev) return null;
  if (c.ma5 == null || prev.ma5 == null) return null;
  if (prev.volume <= 0 || c.open <= 0) return null;

  // 1. 多頭趨勢
  if (detectTrend(candles, index) !== '多頭') return null;

  // 2. 昨日 close < MA5
  if (prev.close >= prev.ma5) return null;

  // 3. 今日 close > MA5
  if (c.close <= c.ma5) return null;

  // 4. 不破前低（書本 p.37 原文，2026-05-09 補實作）
  const pivots = findPivots(candles, index, 8, false); // confirmed only
  const lastLow = pivots.find(p => p.type === 'low');
  if (!lastLow) return null;                   // 沒確認底，無法判定「不破前低」
  if (c.low < lastLow.price) return null;

  // 5. 紅 K + 實體 ≥ 2%
  if (c.close <= c.open) return null;
  const bodyPct = ((c.close - c.open) / c.open) * 100;
  if (bodyPct < 2.0) return null;

  // 6. 量 ≥ 前日 × 1.3
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < 1.3) return null;

  // 7. 收盤 > 前一日 high
  if (c.close <= prev.high) return null;

  // 回檔天數（info only）
  let pullbackDays = 0;
  for (let i = index - 1; i >= Math.max(0, index - 20); i--) {
    const bar = candles[i];
    if (bar.ma5 == null || bar.close >= bar.ma5) break;
    pullbackDays++;
  }

  return {
    prevSwingLow: lastLow.price,
    pullbackDays,
    bodyPct,
    volumeRatio,
    breakoutPrice: prev.high,
  };
}

/**
 * 盤整突破完整 detector — C 買法 + ③ 高勝率位置 3 共用
 *
 * 書本依據：寶典 p.37 多頭趨勢進場 2 大口訣 ② + Part 4 p.299「狹幅盤整 5-6 天」+ Part 7 p.488 攻擊量
 *
 * 11 條 gate（2026-05-09 統一 detector，C 買法獲得 6 天 / tightness / 首次突破等防護）：
 *   1. 至少 2 頭 + 2 底 confirmed pivots
 *   2. 最舊 pivot 到今日 ≥ 6 天
 *   3. 不能是頭頭高+底底高（= 多頭，不是盤整）
 *   4. 上頸線不大幅上揚（新高 ≤ 舊高 × 1.05）
 *   5. 上下頸線線性插值（容許斜頸線）
 *   6. tightness ≤ 15%
 *   7. 上頸線 > 下頸線（防幾何崩潰）
 *   8. 昨收 < 上頸線（首次突破）
 *   9. 今日紅 K + 實體 ≥ 2%
 *   10. 量 ≥ 前日 × 1.3
 *   11. 收盤 > 上頸線
 */
export interface RangeBreakoutResult {
  upperNecklineToday: number;  // 突破價（上頸線）
  lowerNecklineToday: number;  // 停損參考（下頸線）
  preEntryDays: number;        // 盤整持續天數
  bodyPct: number;             // 紅 K 實體 %
  volumeRatio: number;         // 量比
}

export function detectRangeBreakout(
  candles: CandleWithIndicators[],
  index: number,
): RangeBreakoutResult | null {
  if (index < 21) return null;

  const c = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev) return null;
  if (c.open <= 0 || prev.volume <= 0) return null;

  const pivots = findPivots(candles, index, 10);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const lows  = pivots.filter(p => p.type === 'low').slice(0, 2);
  if (highs.length < 2 || lows.length < 2) return null;

  const oldestPivotIdx = Math.min(highs[1].index, lows[1].index);
  const preEntryDays = index - oldestPivotIdx;
  if (preEntryDays < 6) return null;

  // 不能同時是頭頭高+底底高（= 多頭）
  const isUptrend = highs[0].price > highs[1].price && lows[0].price > lows[1].price;
  if (isUptrend) return null;

  // 上頸線不大幅上揚
  if (highs[0].price > highs[1].price * 1.05) return null;

  // 頸線線性插值
  const upperAt = (i: number): number => {
    const [hNew, hOld] = [highs[0], highs[1]];
    if (hNew.index === hOld.index) return hOld.price;
    return hOld.price + (hNew.price - hOld.price) * (i - hOld.index) / (hNew.index - hOld.index);
  };
  const lowerAt = (i: number): number => {
    const [lNew, lOld] = [lows[0], lows[1]];
    if (lNew.index === lOld.index) return lOld.price;
    return lOld.price + (lNew.price - lOld.price) * (i - lOld.index) / (lNew.index - lOld.index);
  };

  const upperToday = upperAt(index);
  const lowerToday = lowerAt(index);
  if (lowerToday <= 0) return null;
  if (upperToday <= lowerToday) return null;

  const tightness = (upperToday - lowerToday) / lowerToday;
  if (tightness > 0.15) return null;

  // 首次突破：昨收 < 上頸線
  const upperYesterday = upperAt(index - 1);
  if (prev.close > upperYesterday) return null;

  // 紅 K + 實體 ≥ 2% + 量 ≥ 1.3x + 收盤 > 上頸線
  if (c.close <= c.open) return null;
  const bodyPct = (c.close - c.open) / c.open;
  if (bodyPct < 0.02) return null;
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < 1.3) return null;
  if (c.close <= upperToday) return null;

  return {
    upperNecklineToday: upperToday,
    lowerNecklineToday: lowerToday,
    preEntryDays,
    bodyPct: bodyPct * 100,
    volumeRatio,
  };
}

/**
 * 高勝率 6 位置總判定（p.749-754）
 * 位置 2-3（pulledBackBuy, rangeBreakout）在 evaluateSixConditions 已算，
 * 本函式負責判 1, 4, 5, 6 四個位置。
 */
export function detectExtraHighWinPositions(
  candles: CandleWithIndicators[],
  index: number,
): {
  bottomTrendConfirm:   boolean;
  maClusterBreak:       boolean;
  strongPullbackResume: boolean;
  falseBreakRebound:    boolean;
} {
  return {
    bottomTrendConfirm:   detectBottomTrendConfirmation(candles, index),
    maClusterBreak:       detectMaClusterBreak(candles, index),
    strongPullbackResume: detectStrongPullbackResume(candles, index),
    falseBreakRebound:    detectFalseBreakRebound(candles, index),
  };
}
