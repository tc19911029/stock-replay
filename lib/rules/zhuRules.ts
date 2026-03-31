/**
 * 朱家泓《做對5個實戰步驟》完整交易規則
 *
 * 五大步驟：選股 → 進場 → 停損 → 操作 → 停利
 * 涵蓋：趨勢判斷、6 個做多位置、6 個做空位置、4 種停損、
 *       長線趨勢操作、短線轉折操作、均線操作、綜合操作、3 大類停利
 */

import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';
import {
  recentHigh,
  recentLow,
  isBullishMAAlignment,
  isBearishMAAlignment,
} from '@/lib/indicators';
import {
  bodyPct,
  isLongRedCandle,
  isLongBlackCandle,
  halfPrice,
  maDeviation,
  isUptrendWave,
  isDowntrendWave,
} from './ruleUtils';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** 台股每碼跳動值 */
function tickSize(price: number): number {
  if (price <= 10) return 0.01;
  if (price <= 50) return 0.05;
  if (price <= 100) return 0.1;
  if (price <= 500) return 0.5;
  if (price <= 1000) return 1.0;
  return 5.0;
}

/** 向下放寬 N 碼 */
function ticksBelow(price: number, ticks: number): number {
  return price - tickSize(price) * ticks;
}

/** 漲跌幅百分比 (close vs open) */
function changePct(c: CandleWithIndicators): number {
  return (c.close - c.open) / c.open;
}

/** 量比 (今日 vs 5日均量) */
function volumeRatio(c: CandleWithIndicators): number | null {
  if (c.avgVol5 == null || c.avgVol5 === 0) return null;
  return c.volume / c.avgVol5;
}

/** 是否為大量 (量比 >= 1.5) */
function isHighVolume(c: CandleWithIndicators): boolean {
  const vr = volumeRatio(c);
  return vr != null && vr >= 1.5;
}

/** 判斷最近 N 日是否在盤整 (振幅 < threshold) */
function isConsolidation(
  candles: CandleWithIndicators[],
  endIndex: number,
  lookback: number,
  threshold = 0.05,
): boolean {
  if (endIndex < lookback) return false;
  const slice = candles.slice(endIndex - lookback, endIndex);
  const highs = slice.map((c) => c.high);
  const lows = slice.map((c) => c.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  if (rangeLow === 0) return false;
  return (rangeHigh - rangeLow) / rangeLow < threshold;
}

/** 判斷最近是否有回檔（前幾日縮量小K線） */
function isPullback(
  candles: CandleWithIndicators[],
  endIndex: number,
  days = 3,
): boolean {
  if (endIndex < days + 1) return false;
  let shrinkCount = 0;
  for (let i = endIndex - days; i < endIndex; i++) {
    const c = candles[i];
    const isSmallBody = bodyPct(c) < 0.02;
    const isLessVol = c.avgVol5 != null && c.volume < c.avgVol5;
    if (isSmallBody || isLessVol) shrinkCount++;
  }
  return shrinkCount >= 2;
}

/** MACD 多頭 (DIF > Signal) */
function isMACDBullish(c: CandleWithIndicators): boolean {
  return c.macdDIF != null && c.macdSignal != null && c.macdDIF > c.macdSignal;
}

/** MACD 空頭 (DIF < Signal) */
function isMACDBearish(c: CandleWithIndicators): boolean {
  return c.macdDIF != null && c.macdSignal != null && c.macdDIF < c.macdSignal;
}

/** 乖離率 (close vs MA) */
function bias(close: number, ma: number | undefined): number | null {
  if (ma == null || ma === 0) return null;
  return ((close - ma) / ma) * 100;
}

/** 連續N根長紅上漲 */
function consecutiveLongRed(candles: CandleWithIndicators[], endIndex: number, n: number): boolean {
  if (endIndex < n - 1) return false;
  for (let i = endIndex - n + 1; i <= endIndex; i++) {
    if (!isLongRedCandle(candles[i])) return false;
  }
  return true;
}

/** 連續N根長黑下跌 */
function consecutiveLongBlack(candles: CandleWithIndicators[], endIndex: number, n: number): boolean {
  if (endIndex < n - 1) return false;
  for (let i = endIndex - n + 1; i <= endIndex; i++) {
    if (!isLongBlackCandle(candles[i])) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 步驟1：選股 SOP 規則
// ═══════════════════════════════════════════════════════════════════════════════

/** 朱家泓選股SOP — 短線做多7項條件全部通過 */
export const zhuShortBullSOP: TradingRule = {
  id: 'zhu-short-bull-sop',
  name: '朱家泓短線做多SOP',
  description: '日線多頭趨勢+均線多頭排列+KD金叉+MACD多頭+量價配合',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return null;

    // 1. 趨勢：頭頭高底底高
    if (!isUptrendWave(candles, index, 10)) return null;

    // 2. 均線多頭排列
    if (!isBullishMAAlignment(c)) return null;

    // 3. 股價在MA5之上
    if (c.close < c.ma5) return null;

    // 4. 量價配合：今日量 >= 5日均量 × 1.2
    const vr = volumeRatio(c);
    if (vr == null || vr < 1.2) return null;

    // 5. KD 金叉或 K > D 向上，MACD 多頭
    const kdBullish = c.kdK != null && c.kdD != null && c.kdK > c.kdD;
    if (!kdBullish) return null;
    if (!isMACDBullish(c)) return null;

    // 6. 確認有進場位置 (長紅K且突破前高)
    if (!isLongRedCandle(c)) return null;
    const prevHigh = recentHigh(candles, index, 5);
    if (c.close < prevHigh) return null;

    return {
      type: 'BUY',
      label: '朱SOP做多',
      description: `短線做多7項全過：趨勢多頭＋MA排列＋量增${vr.toFixed(1)}x＋KD(${c.kdK?.toFixed(0)})＋MACD多頭`,
      reason: [
        '【朱家泓選股SOP】短線做多7項條件全數通過：',
        '① 趨勢：日線頭頭高、底底高（多頭確認）',
        '② 均線：MA5>MA10>MA20 多頭排列向上',
        '③ 股價：收盤在MA5之上',
        `④ 成交量：量增${vr.toFixed(1)}倍（放量上攻）`,
        `⑤ 指標：KD(${c.kdK?.toFixed(0)})多頭、MACD正柱`,
        '⑥ 進場：大量長紅K線突破前高',
        '【操作建議】停損設在本根K線最低點，目標獲利5%~15%',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 朱家泓選股SOP — 短線做空7項條件全部通過 */
export const zhuShortBearSOP: TradingRule = {
  id: 'zhu-short-bear-sop',
  name: '朱家泓短線做空SOP',
  description: '日線空頭趨勢+均線空頭排列+KD死叉+MACD空頭+量價配合',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return null;

    // 1. 趨勢：頭頭低底底低
    if (!isDowntrendWave(candles, index, 10)) return null;

    // 2. 均線空頭排列
    if (!isBearishMAAlignment(c)) return null;

    // 3. 股價在MA5之下
    if (c.close > c.ma5) return null;

    // 4. 量價
    const vr = volumeRatio(c);
    if (vr == null || vr < 1.2) return null;

    // 5. KD 死叉或 K < D，MACD 空頭
    const kdBearish = c.kdK != null && c.kdD != null && c.kdK < c.kdD;
    if (!kdBearish) return null;
    if (!isMACDBearish(c)) return null;

    // 6. 長黑K且跌破前低
    if (!isLongBlackCandle(c)) return null;
    const prevLow = recentLow(candles, index, 5);
    if (c.close > prevLow) return null;

    return {
      type: 'SELL',
      label: '朱SOP做空',
      description: `短線做空7項全過：趨勢空頭＋MA排列＋量增${vr.toFixed(1)}x＋KD(${c.kdK?.toFixed(0)})＋MACD空頭`,
      reason: [
        '【朱家泓選股SOP】短線做空7項條件全數通過：',
        '① 趨勢：日線頭頭低、底底低（空頭確認）',
        '② 均線：MA5<MA10<MA20 空頭排列向下',
        '③ 股價：收盤在MA5之下',
        `④ 成交量：量增${vr.toFixed(1)}倍（放量下殺）`,
        `⑤ 指標：KD(${c.kdK?.toFixed(0)})空頭、MACD負柱`,
        '⑥ 進場：大量長黑K線跌破前低',
        '【操作建議】停損設在本根K線最高點，目標獲利5%~15%',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 步驟2：進場 — 做多6個位置
// ═══════════════════════════════════════════════════════════════════════════════

/** 做多位置1：多頭回檔再上漲 */
export const zhuBullPullbackEntry: TradingRule = {
  id: 'zhu-bull-pullback-entry',
  name: '朱·多頭回檔再上漲',
  description: '多頭趨勢中回檔後出現大量長紅K線上漲，突破前一日高點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return null;

    // 多頭趨勢 + 均線多頭排列
    if (!isBullishMAAlignment(c)) return null;
    if (!isUptrendWave(candles, index, 10)) return null;

    // 前幾日有回檔
    if (!isPullback(candles, index, 3)) return null;

    // 今日大量長紅突破前日高點
    if (!isLongRedCandle(c)) return null;
    if (!isHighVolume(c)) return null;
    if (c.close <= prev.high) return null;

    const stopLoss = c.low;
    const stopPct = ((c.close - stopLoss) / c.close * 100).toFixed(1);

    return {
      type: 'BUY',
      label: '回檔再上漲',
      description: `多頭回檔後大量長紅突破前日高點${prev.high.toFixed(2)}，量比${volumeRatio(c)?.toFixed(1)}x`,
      reason: [
        '【朱家泓進場位置①】多頭回檔再上漲',
        '多頭趨勢中股價回檔數日後，再出現大量長紅K線上漲，突破前一日K線高點，是最安全的買進位置。',
        `停損設在本根K線最低點 ${stopLoss.toFixed(2)} (約${stopPct}%)`,
        '回檔量縮是洗盤，再上漲量增是主力進攻，量價配合確認。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 做多位置2：盤整突破向上 */
export const zhuBullBreakoutEntry: TradingRule = {
  id: 'zhu-bull-breakout-entry',
  name: '朱·盤整突破向上',
  description: '多頭趨勢中盤整後出現大量長紅K線突破盤整區高點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];
    if (c.ma5 == null || c.ma20 == null) return null;

    // 多頭排列
    if (!isBullishMAAlignment(c)) return null;

    // 前幾日盤整
    if (!isConsolidation(candles, index, 5, 0.06)) return null;

    // 今日大量長紅突破盤整高點
    if (!isLongRedCandle(c)) return null;
    if (!isHighVolume(c)) return null;
    const rangeHigh = recentHigh(candles, index, 5);
    if (c.close <= rangeHigh) return null;

    const stopLoss = c.low;

    return {
      type: 'BUY',
      label: '盤整突破',
      description: `盤整後大量長紅突破區間高點${rangeHigh.toFixed(2)}`,
      reason: [
        '【朱家泓進場位置②】盤整突破向上',
        '多頭趨勢中經過盤整蓄勢後，出現大量長紅K線突破盤整區高點。',
        `停損設在本根K線最低點 ${stopLoss.toFixed(2)}`,
        '盤整越久，突破後的漲幅通常越大（蓄勢越深、爆發力越強）。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 做多位置3：急漲回檔均線支撐再上漲 */
export const zhuBullMASupportEntry: TradingRule = {
  id: 'zhu-bull-ma-support-entry',
  name: '朱·均線支撐再上漲',
  description: '多頭急漲回檔到均線附近找到支撐，再出現長紅K線上漲',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null || c.ma10 == null) return null;

    // 多頭趨勢
    if (!isUptrendWave(candles, index, 10)) return null;

    // 前日接近MA10或MA20（低點距離均線在2%以內）
    const distMA10 = prev.ma10 != null ? Math.abs(prev.low - prev.ma10) / prev.ma10 : 1;
    const distMA20 = Math.abs(prev.low - c.ma20) / c.ma20;
    const nearMA = distMA10 < 0.02 || distMA20 < 0.02;
    if (!nearMA) return null;

    // 今日長紅上漲
    if (!isLongRedCandle(c)) return null;
    if (c.close <= prev.high) return null;

    const supportMA = distMA10 < distMA20 ? 'MA10' : 'MA20';

    return {
      type: 'BUY',
      label: '均線撐漲',
      description: `回檔到${supportMA}找到支撐，長紅K線再上漲`,
      reason: [
        '【朱家泓進場位置④】多頭急漲回檔後再上漲',
        `股價回檔到${supportMA}附近獲得支撐，再出現長紅K線上漲。`,
        '均線從壓力轉為支撐，是最佳的加碼位置。',
        `停損設在本根K線最低點 ${c.low.toFixed(2)}`,
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 步驟2：進場 — 做空6個位置
// ═══════════════════════════════════════════════════════════════════════════════

/** 做空位置1：空頭反彈再下跌 */
export const zhuBearBounceEntry: TradingRule = {
  id: 'zhu-bear-bounce-entry',
  name: '朱·空頭反彈再下跌',
  description: '空頭趨勢中反彈後再出現大量長黑K線下跌，跌破前一日低點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return null;

    // 空頭趨勢 + 均線空頭排列
    if (!isBearishMAAlignment(c)) return null;
    if (!isDowntrendWave(candles, index, 10)) return null;

    // 前幾日有反彈（小紅K縮量）
    let bounceCount = 0;
    for (let i = index - 3; i < index; i++) {
      if (i < 0) continue;
      if (candles[i].close > candles[i].open || bodyPct(candles[i]) < 0.02) bounceCount++;
    }
    if (bounceCount < 2) return null;

    // 今日大量長黑跌破前日低點
    if (!isLongBlackCandle(c)) return null;
    if (!isHighVolume(c)) return null;
    if (c.close >= prev.low) return null;

    return {
      type: 'SELL',
      label: '反彈再下跌',
      description: `空頭反彈後大量長黑跌破前日低點${prev.low.toFixed(2)}`,
      reason: [
        '【朱家泓放空位置①】空頭反彈再下跌',
        '空頭趨勢中反彈數日後，再出現大量長黑K線下跌，跌破前一日K線低點。',
        `停損設在本根K線最高點 ${c.high.toFixed(2)}`,
        '空頭反彈是逃命波，反彈結束後跌幅往往更深。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 做空位置2：盤整跌破向下 */
export const zhuBearBreakdownEntry: TradingRule = {
  id: 'zhu-bear-breakdown-entry',
  name: '朱·盤整跌破向下',
  description: '空頭趨勢中盤整後出現大量長黑K線跌破盤整區低點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];
    if (c.ma5 == null || c.ma20 == null) return null;

    // 空頭排列
    if (!isBearishMAAlignment(c)) return null;

    // 前幾日盤整
    if (!isConsolidation(candles, index, 5, 0.06)) return null;

    // 今日大量長黑跌破盤整低點
    if (!isLongBlackCandle(c)) return null;
    if (!isHighVolume(c)) return null;
    const rangeLow = recentLow(candles, index, 5);
    if (c.close >= rangeLow) return null;

    return {
      type: 'SELL',
      label: '盤整跌破',
      description: `盤整後大量長黑跌破區間低點${rangeLow.toFixed(2)}`,
      reason: [
        '【朱家泓放空位置②】盤整跌破向下',
        '空頭趨勢中盤整後，出現大量長黑K線跌破盤整區低點。',
        `停損設在本根K線最高點 ${c.high.toFixed(2)}`,
        '盤整跌破後通常會加速趕底，殺傷力大。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 做空位置3：大量破低長黑 */
export const zhuBearBreakLowEntry: TradingRule = {
  id: 'zhu-bear-break-low-entry',
  name: '朱·大量破低長黑',
  description: '大量跌破前低，收盤放空做次日下跌價差',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];

    if (!isLongBlackCandle(c)) return null;
    if (!isHighVolume(c)) return null;

    // 跌破近20日最低點
    const prevLow = recentLow(candles, index, 20);
    if (c.close >= prevLow) return null;

    return {
      type: 'SELL',
      label: '大量破低',
      description: `大量長黑跌破20日低點${prevLow.toFixed(2)}，量比${volumeRatio(c)?.toFixed(1)}x`,
      reason: [
        '【朱家泓放空位置③】大量破低長黑',
        '大量跌破前面低點的長黑K線，收盤放空，做次日下跌的價差。',
        `停損設在本根K線最高點 ${c.high.toFixed(2)}`,
        '大量破低代表空方力道極強，多頭防線崩潰。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 做空位置4：長黑吞噬 */
export const zhuBearEngulfEntry: TradingRule = {
  id: 'zhu-bear-engulf-entry',
  name: '朱·長黑吞噬',
  description: '多頭高檔大量長紅後次日出現長黑吞噬',
  evaluate(candles, index): RuleSignal | null {
    if (index < 2) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 前日是大量長紅
    if (!isLongRedCandle(prev)) return null;
    const prevVR = prev.avgVol5 != null && prev.avgVol5 > 0 ? prev.volume / prev.avgVol5 : 0;
    if (prevVR < 1.3) return null;

    // 今日長黑收盤跌破昨日長紅低點（吞噬）
    if (!isLongBlackCandle(c)) return null;
    if (c.close > prev.low) return null;

    // 高檔判斷：股價在MA20之上且正乖離 > 10%
    const dev = maDeviation(c, 'ma20');
    if (dev == null || dev < 0.10) return null;

    return {
      type: 'SELL',
      label: '長黑吞噬',
      description: `高檔長黑吞噬：收盤${c.close}跌破昨日長紅低點${prev.low.toFixed(2)}`,
      reason: [
        '【朱家泓放空位置④】長黑吞噬',
        '多頭高檔大量長紅K上漲，次日出現大量長黑K線，收盤跌破昨日長紅K低點。',
        '這是強烈的多翻空訊號，主力出貨跡象明顯。',
        `停損設在今日K線最高點 ${c.high.toFixed(2)}`,
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 步驟3：停損規則
// ═══════════════════════════════════════════════════════════════════════════════

/** 停損方法1：跌破進場K線最低點（做多） */
export const zhuStopLossKlineLow: TradingRule = {
  id: 'zhu-stoploss-kline-low',
  name: '朱·跌破進場K線低點',
  description: '收盤跌破近期進場長紅K線的最低點，執行停損出場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];

    // 找最近5日內的進場長紅K（最大漲幅的那根）
    let entryCandle: CandleWithIndicators | null = null;
    let maxGain = 0;
    for (let i = index - 4; i < index; i++) {
      if (i < 0) continue;
      const cd = candles[i];
      if (isLongRedCandle(cd) && changePct(cd) > maxGain) {
        maxGain = changePct(cd);
        entryCandle = cd;
      }
    }
    if (entryCandle == null) return null;

    // 計算停損價
    let stopPrice: number;
    if (changePct(entryCandle) < 0.025) {
      // 漲幅 < 2.5%：最低點再向下放寬2碼
      stopPrice = ticksBelow(entryCandle.low, 2);
    } else if (changePct(entryCandle) >= 0.045) {
      // 漲幅 >= 4.5%（高檔大量長紅）：停損在1/2位置
      stopPrice = halfPrice(entryCandle);
    } else {
      stopPrice = entryCandle.low;
    }

    // 收盤跌破停損價
    if (c.close >= stopPrice) return null;

    const lossPct = ((stopPrice - c.close) / stopPrice * 100).toFixed(1);

    return {
      type: 'SELL',
      label: '停損出場',
      description: `收盤${c.close}跌破停損價${stopPrice.toFixed(2)}（進場K線低點法）`,
      reason: [
        '【朱家泓停損方法①】進場K線高低點',
        `進場K線漲幅${(maxGain * 100).toFixed(1)}%，停損設在${stopPrice.toFixed(2)}`,
        `今日收盤${c.close}已跌破，損失約${lossPct}%，執行停損出場。`,
        '嚴格執行停損，保住資金才有翻身機會。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 停損：趨勢改變立即出場 */
export const zhuStopLossTrendChange: TradingRule = {
  id: 'zhu-stoploss-trend-change',
  name: '朱·趨勢改變停損',
  description: '多頭趨勢中出現頭頭低的轉折，趨勢改變立即出場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];

    // 之前是多頭（10日前看有上漲波浪）
    const wasBull = isUptrendWave(candles, index - 5, 10);
    if (!wasBull) return null;

    // 現在出現下跌訊號：長黑跌破前面低點 + 跌破MA5和MA10
    if (!isLongBlackCandle(c)) return null;
    if (c.ma5 == null || c.ma10 == null) return null;
    if (c.close > c.ma5 || c.close > c.ma10) return null;

    const prevLow = recentLow(candles, index, 3);
    if (c.close > prevLow) return null;

    return {
      type: 'SELL',
      label: '趨勢變停損',
      description: `趨勢改變：長黑跌破前低${prevLow.toFixed(2)}且破MA5/MA10`,
      reason: [
        '【朱家泓停損認知⑤】趨勢改變立即出場',
        '即使沒有到達停損價，只要趨勢改變就要立刻出場。',
        '出現頭頭低（跌破前面低點），多頭趨勢已破壞。',
        '長黑K同時跌破MA5和MA10，空頭力道轉強，不要猶豫。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 停損上限10%：超過10%強制出場 */
export const zhuStopLossMax10Pct: TradingRule = {
  id: 'zhu-stoploss-max-10pct',
  name: '朱·停損上限10%',
  description: '從近期高點下跌超過10%，強制停損出場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];

    // 找近10日最高收盤價
    let maxClose = 0;
    for (let i = index - 9; i <= index; i++) {
      if (candles[i].close > maxClose) maxClose = candles[i].close;
    }

    const drawdown = (maxClose - c.close) / maxClose;
    if (drawdown < 0.10) return null;

    return {
      type: 'SELL',
      label: '10%停損',
      description: `從近期高點${maxClose.toFixed(2)}下跌${(drawdown * 100).toFixed(1)}%，觸發10%停損上限`,
      reason: [
        '【朱家泓停損認知⑥】停損最多10%',
        '一檔股票如果進場前充分研判，符合進場條件才買進，',
        '結果走勢卻背道而馳，不能奢望它會大漲。',
        '停損不能超過10%，否則日後難以反敗為勝。絕不向下攤平！',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 步驟4：操作規則
// ═══════════════════════════════════════════════════════════════════════════════

/** 長線趨勢操作：跌破MA20出場 */
export const zhuLongTrendMA20Exit: TradingRule = {
  id: 'zhu-long-trend-ma20-exit',
  name: '朱·長線跌破MA20',
  description: '長線趨勢操作中，收盤跌破MA20日均線，出場觀望',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null || prev.ma20 == null) return null;

    // 之前在MA20之上（前日收盤 > MA20）
    if (prev.close <= prev.ma20) return null;

    // 今日跌破MA20
    if (c.close >= c.ma20) return null;

    // 確認是有意義的跌破（長黑K或連跌）
    if (!isLongBlackCandle(c) && c.close > candles[index - 1].low) return null;

    return {
      type: 'SELL',
      label: '破MA20出場',
      description: `長線操作：收盤${c.close}跌破MA20(${c.ma20.toFixed(2)})`,
      reason: [
        '【朱家泓長線均線操作法】日線波浪型態+MA20',
        '規則：跌破MA20日均線出場。',
        '若多頭趨勢未改變（頭頭仍高），等待回檔到MA20支撐再進場。',
        '若同時出現頭頭低，則多頭趨勢改變，停止做多操作。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 短線K線操作：跌破前一日K線最低點出場 */
export const zhuShortKlineExit: TradingRule = {
  id: 'zhu-short-kline-exit',
  name: '朱·短線K線轉折出場',
  description: '短線K線操作法：收盤跌破前一日K線最低點，轉折確認出場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 2) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 前日是紅K（持有多單中）
    if (prev.close <= prev.open) return null;

    // 今日黑K收盤跌破前日最低點
    if (c.close >= c.open) return null; // 今日要是黑K
    if (c.close >= prev.low) return null;

    return {
      type: 'REDUCE',
      label: 'K線轉折',
      description: `黑K收盤${c.close}跌破前日低點${prev.low.toFixed(2)}，短線轉折確認`,
      reason: [
        '【朱家泓短線K線操作法】',
        '做多時，每日收盤守前一日K線最低點。',
        '今日黑K收盤跌破前日K線最低點，轉折確認，短線多單出場。',
        '若多頭趨勢未變，等待下一個轉折上漲確認點再進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 短線MA5操作：跌破MA5均線出場 */
export const zhuShortMA5Exit: TradingRule = {
  id: 'zhu-short-ma5-exit',
  name: '朱·短線跌破MA5',
  description: '短線MA5均線操作法：收盤跌破MA5均線，出場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma5 == null || prev.ma5 == null) return null;

    // 前日在MA5之上
    if (prev.close <= prev.ma5) return null;

    // 今日跌破MA5
    if (c.close >= c.ma5) return null;

    return {
      type: 'REDUCE',
      label: '破MA5出場',
      description: `收盤${c.close}跌破MA5(${c.ma5.toFixed(2)})`,
      reason: [
        '【朱家泓短線均線操作法】MA5',
        '做多時以MA5為操作依據，收盤跌破MA5即出場。',
        '此方法進出較頻繁，但能快速鎖定短線利潤。',
        '適合短線轉折操作和逆勢操作使用。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 綜合操作：乖離過大改用MA5停利 */
export const zhuBiasWarning: TradingRule = {
  id: 'zhu-bias-warning',
  name: '朱·高乖離警示',
  description: '股價與MA20乖離超過±15%，注意停利',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    if (c.ma20 == null) return null;

    const dev = bias(c.close, c.ma20);
    if (dev == null) return null;

    if (Math.abs(dev) < 15) return null;

    const direction = dev > 0 ? '正' : '負';
    const action = dev > 0 ? '多單改用MA3或MA5停利' : '空單改用MA3或MA5停利';

    return {
      type: 'WATCH',
      label: '高乖離',
      description: `${direction}乖離${Math.abs(dev).toFixed(1)}% (vs MA20)，超過15%閾值`,
      reason: [
        '【朱家泓綜合操作法】乖離過大策略切換',
        `目前股價與MA20月線${direction}乖離${Math.abs(dev).toFixed(1)}%，超過15%。`,
        `建議${action}，先落袋為安。`,
        '短線急漲或急跌後容易急速反轉，要掌握獲利先入袋。',
        '停利後如果趨勢沒改變，繼續操作原方向。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 步驟5：停利規則
// ═══════════════════════════════════════════════════════════════════════════════

/** 停利：獲利達10%且出現轉折K線 */
export const zhuTakeProfit10Pct: TradingRule = {
  id: 'zhu-takeprofit-10pct',
  name: '朱·10%目標停利',
  description: '獲利達10%後出現不漲或下跌K線，停利出場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];

    // 找近10日最低收盤（假設為進場價）
    let minClose = Infinity;
    for (let i = index - 9; i < index; i++) {
      if (candles[i].close < minClose) minClose = candles[i].close;
    }

    const profit = (c.close - minClose) / minClose;
    if (profit < 0.10) return null;

    // 出現不漲或下跌訊號：黑K或十字線
    const isWeakK = c.close <= c.open || bodyPct(c) < 0.005;
    if (!isWeakK) return null;

    return {
      type: 'REDUCE',
      label: '10%停利',
      description: `獲利約${(profit * 100).toFixed(1)}%達10%目標，出現轉弱K線`,
      reason: [
        '【朱家泓預設獲利目標停利】10%',
        `近期低點${minClose.toFixed(2)}到今日${c.close}，獲利約${(profit * 100).toFixed(1)}%。`,
        '已超過10%目標，且今日出現不漲或下跌的K線。',
        '建議停利出場，落袋為安。趨勢未變可等下一個進場點。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 停利：做多高檔連續長紅急漲後爆量轉折 */
export const zhuTakeProfitHighClimaxBull: TradingRule = {
  id: 'zhu-takeprofit-high-climax-bull',
  name: '朱·高檔急漲停利',
  description: '連續3根以上長紅急漲後，爆大量且K線出現轉折訊號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];

    // 前3根連續長紅
    if (!consecutiveLongRed(candles, index - 1, 3)) return null;

    // 今日爆大量
    if (!isHighVolume(c)) return null;

    // 今日出現轉折訊號：長黑、長上影線、十字線
    const upperShadow = (c.high - Math.max(c.open, c.close)) / c.high;
    const isReversal = isLongBlackCandle(c) || upperShadow > 0.03 || bodyPct(c) < 0.005;
    if (!isReversal) return null;

    return {
      type: 'REDUCE',
      label: '高檔急漲停利',
      description: `連續長紅急漲後爆大量${volumeRatio(c)?.toFixed(1)}x，出現轉折K線`,
      reason: [
        '【朱家泓特定條件停利③】做多高檔停利',
        '連續3根以上長紅上漲K線（末升段急漲），今日爆大量並出現K線轉折訊號。',
        '高檔爆大量通常是主力出貨的訊號，獲利要先入袋。',
        '出場後如果再出現繼續強勢上漲，可以再介入操作。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 停利：做空低檔連續長黑急跌後爆量轉折 */
export const zhuTakeProfitLowClimaxBear: TradingRule = {
  id: 'zhu-takeprofit-low-climax-bear',
  name: '朱·低檔急跌停利',
  description: '連續3根以上長黑急跌後，爆大量且K線出現轉折訊號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];

    // 前3根連續長黑
    if (!consecutiveLongBlack(candles, index - 1, 3)) return null;

    // 今日爆大量
    if (!isHighVolume(c)) return null;

    // 今日出現止跌訊號：長紅、長下影線
    const lowerShadow = (Math.min(c.open, c.close) - c.low) / c.low;
    const isReversal = isLongRedCandle(c) || lowerShadow > 0.03;
    if (!isReversal) return null;

    return {
      type: 'ADD',
      label: '低檔急跌回補',
      description: `連續長黑急跌後爆大量${volumeRatio(c)?.toFixed(1)}x，出現止跌K線`,
      reason: [
        '【朱家泓特定條件停利④】做空低檔停利',
        '連續3根以上長黑下跌K線（末跌段急跌），今日爆大量並出現K線轉折訊號。',
        '低檔爆大量通常是空方力竭、多方進場的訊號。',
        '空單應停利回補，避免反彈被軋。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 停利：做多到達重大壓力區 */
export const zhuTakeProfitResistance: TradingRule = {
  id: 'zhu-takeprofit-resistance',
  name: '朱·到達壓力停利',
  description: '股價上漲到前波高點壓力區，爆大量出現止漲訊號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 60) return null;
    const c = candles[index];

    // 找60日內的最高點（壓力區）
    const high60 = recentHigh(candles, index, 60);

    // 接近壓力區（距離 < 3%）
    const distToResist = (high60 - c.close) / high60;
    if (distToResist > 0.03 || distToResist < -0.01) return null;

    // 爆大量 + 出現止漲K線
    if (!isHighVolume(c)) return null;
    const isWeakK = isLongBlackCandle(c) || bodyPct(c) < 0.005;
    if (!isWeakK) return null;

    return {
      type: 'REDUCE',
      label: '壓力區停利',
      description: `到達前高壓力${high60.toFixed(2)}附近，爆量出現止漲K線`,
      reason: [
        '【朱家泓特定條件停利①】做多到達壓力停利',
        `股價接近60日前高壓力區${high60.toFixed(2)}。`,
        '到達重大壓力時爆大量止漲回跌，多單應停利出場。',
        '壓力區包括：前波高點、週線壓力、密集盤整區等。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 匯出所有朱家泓規則
// ═══════════════════════════════════════════════════════════════════════════════

export const ZHU_RULES: TradingRule[] = [
  // 步驟1：選股SOP
  zhuShortBullSOP,
  zhuShortBearSOP,
  // 步驟2：進場 — 做多
  zhuBullPullbackEntry,
  zhuBullBreakoutEntry,
  zhuBullMASupportEntry,
  // 步驟2：進場 — 做空
  zhuBearBounceEntry,
  zhuBearBreakdownEntry,
  zhuBearBreakLowEntry,
  zhuBearEngulfEntry,
  // 步驟3：停損
  zhuStopLossKlineLow,
  zhuStopLossTrendChange,
  zhuStopLossMax10Pct,
  // 步驟4：操作
  zhuLongTrendMA20Exit,
  zhuShortKlineExit,
  zhuShortMA5Exit,
  zhuBiasWarning,
  // 步驟5：停利
  zhuTakeProfit10Pct,
  zhuTakeProfitHighClimaxBull,
  zhuTakeProfitLowClimaxBear,
  zhuTakeProfitResistance,
];
