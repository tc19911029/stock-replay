/**
 * 走圖SOP規則 — 林穎《學會走圖SOP 讓技術分析養我一輩子》
 *
 * 多單進場3種模式：
 *   1. sopBullConfirmEntry    — 多頭確認進場（底底高紅K過前高）
 *   2. sopBullPullbackBuy     — 多頭回後買上漲（紅K站上5MA+過前日高點）
 *   3. sopConsolidationBreakout — 盤整突破做多（紅K突破壓力線）
 *
 * 空單進場3種模式：
 *   4. sopBearConfirmEntry    — 空頭確認進場（頭頭低黑K破前低）
 *   5. sopBearBounceSell      — 空頭彈後空下跌（黑K跌破5MA+破前日低點）
 *   6. sopConsolidationBreakdown — 盤整跌破做空（黑K跌破支撐線）
 *
 * 每條規則檢查書中6大條件：趨勢、位置、K棒、均線、成交量、指標
 * KD 參數：5,3,3 / MACD 參數：10,20,10
 * 雙指標只要其中1個符合即可
 */
import { CandleWithIndicators, TradingRule, RuleSignal } from '@/types';
import { bodyPct } from './ruleUtils';
import { findPivots, detectTrend, detectTrendPosition } from '@/lib/analysis/trendAnalysis';
import { isBullishMAAlignment, isBearishMAAlignment } from '@/lib/indicators';

// ── Helpers ──────────────────────────────────────────────────────────────────

const MIN_BARS = 25;
const BODY_MIN = 0.02; // 實體 > 2% 才有攻擊力道

/** KD 多單進場條件：K值向上 / KD多排(K>D) / KD黃金交叉，符合其一 */
function kdBullish(c: CandleWithIndicators, prev: CandleWithIndicators): boolean {
  if (c.kdK == null || c.kdD == null || prev.kdK == null || prev.kdD == null) return false;
  const kUp = c.kdK > prev.kdK;
  const kAboveD = c.kdK > c.kdD;
  const goldenCross = prev.kdK <= prev.kdD && c.kdK > c.kdD;
  return kUp || kAboveD || goldenCross;
}

/** KD 空單進場條件：K值向下 / KD空排(K<D) / KD死亡交叉，符合其一 */
function kdBearish(c: CandleWithIndicators, prev: CandleWithIndicators): boolean {
  if (c.kdK == null || c.kdD == null || prev.kdK == null || prev.kdD == null) return false;
  const kDown = c.kdK < prev.kdK;
  const kBelowD = c.kdK < c.kdD;
  const deathCross = prev.kdK >= prev.kdD && c.kdK < c.kdD;
  return kDown || kBelowD || deathCross;
}

/** MACD 多單進場條件：紅柱延長 / 綠柱縮短 / 綠柱轉紅柱，符合其一 */
function macdBullish(c: CandleWithIndicators, prev: CandleWithIndicators): boolean {
  if (c.macdOSC == null || prev.macdOSC == null) return false;
  const redExtend = c.macdOSC > 0 && c.macdOSC > prev.macdOSC;
  const greenShrink = c.macdOSC < 0 && c.macdOSC > prev.macdOSC;
  const greenToRed = prev.macdOSC <= 0 && c.macdOSC > 0;
  return redExtend || greenShrink || greenToRed;
}

/** MACD 空單進場條件：綠柱延長 / 紅柱縮短 / 紅柱轉綠柱，符合其一 */
function macdBearish(c: CandleWithIndicators, prev: CandleWithIndicators): boolean {
  if (c.macdOSC == null || prev.macdOSC == null) return false;
  const greenExtend = c.macdOSC < 0 && c.macdOSC < prev.macdOSC;
  const redShrink = c.macdOSC > 0 && c.macdOSC < prev.macdOSC;
  const redToGreen = prev.macdOSC >= 0 && c.macdOSC < 0;
  return greenExtend || redShrink || redToGreen;
}

/** 雙指標至少1個符合（多單） */
function dualIndicatorBullish(c: CandleWithIndicators, prev: CandleWithIndicators): boolean {
  return kdBullish(c, prev) || macdBullish(c, prev);
}

/** 雙指標至少1個符合（空單） */
function dualIndicatorBearish(c: CandleWithIndicators, prev: CandleWithIndicators): boolean {
  return kdBearish(c, prev) || macdBearish(c, prev);
}

/** 量能確認（多單用）：量 > 前日1.3倍 或 > 5日均量 */
function volumeConfirmBull(c: CandleWithIndicators, prev: CandleWithIndicators): boolean {
  if (c.volume == null || prev.volume == null) return false;
  const vsYesterday = prev.volume > 0 ? c.volume / prev.volume >= 1.3 : false;
  const vsAvg = c.avgVol5 != null && c.avgVol5 > 0 ? c.volume > c.avgVol5 : false;
  return vsYesterday || vsAvg;
}

/** 3條均線方向向上：MA5 > 前日MA5, MA10 > 前日MA10, MA20 > 前日MA20 */
function masTrendingUp(c: CandleWithIndicators, prev: CandleWithIndicators): boolean {
  if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return false;
  if (prev.ma5 == null || prev.ma10 == null || prev.ma20 == null) return false;
  return c.ma5 > prev.ma5 && c.ma10 > prev.ma10 && c.ma20 > prev.ma20;
}

/** 3條均線方向向下 */
function masTrendingDown(c: CandleWithIndicators, prev: CandleWithIndicators): boolean {
  if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return false;
  if (prev.ma5 == null || prev.ma10 == null || prev.ma20 == null) return false;
  return c.ma5 < prev.ma5 && c.ma10 < prev.ma10 && c.ma20 < prev.ma20;
}

/** 找最近的轉折高點價格 */
function recentPivotHigh(candles: CandleWithIndicators[], index: number): number | null {
  const pivots = findPivots(candles, index, 10);
  const high = pivots.find(p => p.type === 'high');
  return high?.price ?? null;
}

/** 找最近的轉折低點價格 */
function recentPivotLow(candles: CandleWithIndicators[], index: number): number | null {
  const pivots = findPivots(candles, index, 10);
  const low = pivots.find(p => p.type === 'low');
  return low?.price ?? null;
}

/** 找盤整區的上頸線（壓力線）和下頸線（支撐線） */
function findConsolidationBounds(
  candles: CandleWithIndicators[],
  index: number,
): { upper: number; lower: number } | null {
  const pivots = findPivots(candles, index, 10);
  const highs = pivots.filter(p => p.type === 'high').map(p => p.price);
  const lows = pivots.filter(p => p.type === 'low').map(p => p.price);
  if (highs.length < 2 || lows.length < 2) return null;
  return {
    upper: Math.max(highs[0], highs[1]),
    lower: Math.min(lows[0], lows[1]),
  };
}

// ── Rule 1: 多頭確認進場 ─────────────────────────────────────────────────────

export const sopBullConfirmEntry: TradingRule = {
  id: 'sop-bull-confirm-entry',
  name: '走圖SOP｜多頭確認進場',
  description: '底底高，紅K收盤站上前面轉折高點＋月線＋三線向上＋帶量＋雙指標',

  evaluate(candles: CandleWithIndicators[], index: number): RuleSignal | null {
    if (index < MIN_BARS) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null) return null;

    // ① 趨勢：必須是多頭
    const trend = detectTrend(candles, index);
    if (trend !== '多頭') return null;

    // ② 位置：不在末升段
    const pos = detectTrendPosition(candles, index);
    if (pos === '末升段(高檔)') return null;

    // ③ K棒：實體紅K > 2%，收盤過前面轉折高
    if (c.close <= c.open) return null; // 必須是紅K
    if (bodyPct(c) < BODY_MIN) return null;
    const pivotHigh = recentPivotHigh(candles, index);
    if (pivotHigh == null || c.close <= pivotHigh) return null;

    // ④ 均線：收盤站上月線(20MA)，三線方向向上
    if (c.close < c.ma20) return null;
    if (!isBullishMAAlignment(c)) return null;
    if (!masTrendingUp(c, prev)) return null;

    // ⑤ 成交量：帶量（> 前日1.3倍 或 > 5日均量）
    if (!volumeConfirmBull(c, prev)) return null;

    // ⑥ 指標：KD/MACD 至少1個符合
    if (!dualIndicatorBullish(c, prev)) return null;

    return {
      type: 'BUY',
      label: '走圖SOP多頭確認',
      description: `紅K收盤 ${c.close} 站上轉折高 ${pivotHigh.toFixed(1)}，MA三線向上，帶量突破`,
      reason: '底底高＋紅K過前高＝多頭趨勢確認，6大條件全過，是第一個多單進場位置。進場後記錄：成本價、5%停損價、10%獲利目標價。',
      ruleId: 'sop-bull-confirm-entry',
    };
  },
};

// ── Rule 2: 多頭回後買上漲 ───────────────────────────────────────────────────

export const sopBullPullbackBuy: TradingRule = {
  id: 'sop-bull-pullback-buy',
  name: '走圖SOP｜多頭回後買上漲',
  description: '多頭回檔後紅K收盤站上5MA＋過前日K棒高點＋月線之上＋雙指標',

  evaluate(candles: CandleWithIndicators[], index: number): RuleSignal | null {
    if (index < MIN_BARS) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma5 == null || c.ma20 == null) return null;

    // ① 趨勢：必須是多頭
    const trend = detectTrend(candles, index);
    if (trend !== '多頭') return null;

    // ② 位置：不在末升段
    const pos = detectTrendPosition(candles, index);
    if (pos === '末升段(高檔)') return null;

    // 必須有回檔跡象：前日收盤 ≤ 5MA（代表之前有回檔修正）
    if (prev.ma5 == null || prev.close > prev.ma5) return null;

    // ③ K棒：實體紅K（書本要求 ≥ 2% 才算「上漲確認」），收盤站上5MA，且站上前日K棒最高價
    if (c.close <= c.open) return null;
    if (bodyPct(c) < BODY_MIN) return null;
    if (c.close < c.ma5) return null;
    if (c.close <= prev.high) return null;

    // ④ 均線：收盤在月線(20MA)之上
    if (c.close < c.ma20) return null;

    // ⑤ 成交量：多頭架構下有量無量都會漲，但有量更好（放寬）
    // 書中說：多頭架構不變，股價持續上漲，有量無量都會漲

    // ⑥ 指標：KD/MACD 至少1個符合
    if (!dualIndicatorBullish(c, prev)) return null;

    return {
      type: 'BUY',
      label: '走圖SOP回後買上漲',
      description: `紅K收盤 ${c.close} 站上5MA(${c.ma5.toFixed(1)})＋過前日高 ${prev.high}`,
      reason: '多頭回檔修正後再上漲＝多頭續勢訊號。收盤站上5日均線且突破前日K棒高點，代表多方力道回歸。進場後守5%停損、設10%獲利目標。',
      ruleId: 'sop-bull-pullback-buy',
    };
  },
};

// ── Rule 3: 盤整突破做多 ─────────────────────────────────────────────────────

export const sopConsolidationBreakout: TradingRule = {
  id: 'sop-consolidation-breakout',
  name: '走圖SOP｜盤整突破做多',
  description: '盤整末端紅K收盤突破壓力線＋月線之上＋帶量＋雙指標',

  evaluate(candles: CandleWithIndicators[], index: number): RuleSignal | null {
    if (index < MIN_BARS) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null) return null;

    // ① 趨勢：盤整（非多頭也非空頭）
    const trend = detectTrend(candles, index);
    if (trend !== '盤整') return null;

    // 找盤整區上下頸線
    const bounds = findConsolidationBounds(candles, index);
    if (bounds == null) return null;

    // ③ K棒：實體紅K，收盤突破盤整區上頸線
    if (c.close <= c.open) return null;
    if (bodyPct(c) < BODY_MIN) return null;
    if (c.close <= bounds.upper) return null;
    // 前日收盤必須還在盤整區內
    if (prev.close > bounds.upper) return null;

    // ④ 均線：收盤站上月線(20MA)
    if (c.close < c.ma20) return null;

    // ⑤ 成交量：帶量突破
    if (!volumeConfirmBull(c, prev)) return null;

    // ⑥ 指標：KD/MACD 至少1個符合
    if (!dualIndicatorBullish(c, prev)) return null;

    return {
      type: 'BUY',
      label: '走圖SOP盤整突破',
      description: `紅K收盤 ${c.close} 突破盤整壓力線 ${bounds.upper.toFixed(1)}，帶量突破`,
      reason: '盤整末端出現帶量紅K突破壓力線＝多頭續勢確認。盤整突破後股價容易再攻一波。停損設在突破紅K的最低點（含下影線）。',
      ruleId: 'sop-consolidation-breakout',
    };
  },
};

// ── Rule 4: 空頭確認進場 ─────────────────────────────────────────────────────

export const sopBearConfirmEntry: TradingRule = {
  id: 'sop-bear-confirm-entry',
  name: '走圖SOP｜空頭確認進場',
  description: '頭頭低，黑K收盤跌破前面轉折低點＋月線之下＋三線向下＋雙指標',

  evaluate(candles: CandleWithIndicators[], index: number): RuleSignal | null {
    if (index < MIN_BARS) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null) return null;

    // ① 趨勢：必須是空頭
    const trend = detectTrend(candles, index);
    if (trend !== '空頭') return null;

    // ② 位置：不在末跌段
    const pos = detectTrendPosition(candles, index);
    if (pos === '末跌段(低檔)') return null;

    // ③ K棒：實體黑K > 2%，收盤跌破前面轉折低
    if (c.close >= c.open) return null; // 必須是黑K
    if (bodyPct(c) < BODY_MIN) return null;
    const pivotLow = recentPivotLow(candles, index);
    if (pivotLow == null || c.close >= pivotLow) return null;

    // ④ 均線：收盤在月線(20MA)之下，三線方向向下
    if (c.close > c.ma20) return null;
    if (!isBearishMAAlignment(c)) return null;
    if (!masTrendingDown(c, prev)) return null;

    // ⑤ 成交量：空頭趨勢下跌不需要特別考慮成交量
    // 書中明確說：做空不用特別考慮成交量，有量沒量都會跌

    // ⑥ 指標：KD/MACD 至少1個符合
    if (!dualIndicatorBearish(c, prev)) return null;

    return {
      type: 'SELL',
      label: '走圖SOP空頭確認',
      description: `黑K收盤 ${c.close} 跌破轉折低 ${pivotLow.toFixed(1)}，MA三線向下`,
      reason: '頭頭低＋黑K破前低＝空頭趨勢確認，是第一個空單進場位置。空頭下跌有量沒量都會跌。進場後記錄：成本價、5%停損價、10%獲利目標價。',
      ruleId: 'sop-bear-confirm-entry',
    };
  },
};

// ── Rule 5: 空頭彈後空下跌 ───────────────────────────────────────────────────

export const sopBearBounceSell: TradingRule = {
  id: 'sop-bear-bounce-sell',
  name: '走圖SOP｜空頭彈後空下跌',
  description: '空頭反彈後黑K收盤跌破5MA＋破前日K棒低點＋月線向下＋雙指標',

  evaluate(candles: CandleWithIndicators[], index: number): RuleSignal | null {
    if (index < MIN_BARS) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma5 == null || c.ma20 == null) return null;

    // ① 趨勢：必須是空頭
    const trend = detectTrend(candles, index);
    if (trend !== '空頭') return null;

    // ② 位置：不在末跌段
    const pos = detectTrendPosition(candles, index);
    if (pos === '末跌段(低檔)') return null;

    // 必須有反彈跡象：前日收盤 ≥ 5MA（代表之前有反彈）
    if (prev.ma5 == null || prev.close < prev.ma5) return null;

    // ③ K棒：實體黑K（書本要求 ≥ 2% 才算「下跌確認」），收盤跌破5MA，且跌破前日K棒最低價
    if (c.close >= c.open) return null;
    if (bodyPct(c) < BODY_MIN) return null;
    if (c.close > c.ma5) return null;
    if (c.close >= prev.low) return null;

    // ④ 均線：月線方向持續向下
    if (prev.ma20 == null || c.ma20 >= prev.ma20) return null;

    // ⑤ 成交量：無論大量或小量皆可（空頭特性）

    // ⑥ 指標：KD/MACD 至少1個符合
    if (!dualIndicatorBearish(c, prev)) return null;

    return {
      type: 'SELL',
      label: '走圖SOP彈後空下跌',
      description: `黑K收盤 ${c.close} 跌破5MA(${c.ma5.toFixed(1)})＋破前日低 ${prev.low}`,
      reason: '空頭趨勢反彈後再下跌＝空頭續勢訊號。黑K收盤跌破5日均線且破前日K棒低點，代表空方力道回歸。成交量大量或小量皆可。',
      ruleId: 'sop-bear-bounce-sell',
    };
  },
};

// ── Rule 6: 盤整跌破做空 ─────────────────────────────────────────────────────

export const sopConsolidationBreakdown: TradingRule = {
  id: 'sop-consolidation-breakdown',
  name: '走圖SOP｜盤整跌破做空',
  description: '盤整末端黑K收盤跌破支撐線＋月線之下＋雙指標',

  evaluate(candles: CandleWithIndicators[], index: number): RuleSignal | null {
    if (index < MIN_BARS) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null) return null;

    // ① 趨勢：盤整
    const trend = detectTrend(candles, index);
    if (trend !== '盤整') return null;

    // 找盤整區上下頸線
    const bounds = findConsolidationBounds(candles, index);
    if (bounds == null) return null;

    // ③ K棒：實體黑K，收盤跌破盤整區下頸線
    if (c.close >= c.open) return null;
    if (bodyPct(c) < BODY_MIN) return null;
    if (c.close >= bounds.lower) return null;
    // 前日收盤必須還在盤整區內
    if (prev.close < bounds.lower) return null;

    // ④ 均線：收盤在月線(20MA)之下
    if (c.close > c.ma20) return null;

    // ⑤ 成交量：無論大量或小量皆可

    // ⑥ 指標：KD/MACD 至少1個符合
    if (!dualIndicatorBearish(c, prev)) return null;

    return {
      type: 'SELL',
      label: '走圖SOP盤整跌破',
      description: `黑K收盤 ${c.close} 跌破盤整支撐線 ${bounds.lower.toFixed(1)}`,
      reason: '盤整末端出現黑K跌破支撐線＝空頭續勢確認。股價容易再跌一波。停損設在跌破黑K的最高點（含上影線）。',
      ruleId: 'sop-consolidation-breakdown',
    };
  },
};
