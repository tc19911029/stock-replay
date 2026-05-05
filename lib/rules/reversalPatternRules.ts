/**
 * 變盤線偵測規則 — 林穎《學會走圖SOP》
 *
 * 書中特別強調的轉折K棒訊號：
 *
 * 1. sopHighReversalWarning — 高檔變盤訊號（多單準備停利）
 *    - 大量中長黑K / 倒T變盤線 / 十字變盤線 / 天劍線
 *    - 價量背離 / KD背離 / MACD背離
 *    - 高檔爆量後3日不創新高
 *
 * 2. sopLowReversalSignal — 低檔變盤訊號（空單準備停利）
 *    - 大量中長紅K / T字變盤線 / 十字變盤線 / 蜻蜓線
 *    - 低檔爆量 / KD背離 / MACD背離
 *    - 低檔爆量後3日不創新低
 */
import { CandleWithIndicators, TradingRule, RuleSignal } from '@/types';
import { bodyPct } from './ruleUtils';
import { detectTrendPosition } from '@/lib/analysis/trendAnalysis';

const MIN_BARS = 25;

// ── K棒型態偵測 helpers ──────────────────────────────────────────────────────

/** 十字變盤線：實體很小（< 0.5%），有上下影線 */
function isDoji(c: CandleWithIndicators): boolean {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range <= 0) return false;
  return body / range < 0.15 && body / c.open < 0.005;
}

/** 倒T字線（gravestone doji）：長上影線，實體+下影線很小，出現在高檔是止漲訊號 */
function isGravestoneDoji(c: CandleWithIndicators): boolean {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range <= 0) return false;
  const upperShadow = c.high - Math.max(c.close, c.open);
  const lowerShadow = Math.min(c.close, c.open) - c.low;
  return upperShadow / range > 0.6 && (body + lowerShadow) / range < 0.3;
}

/** T字變盤線（dragonfly doji）：長下影線，實體+上影線很小，出現在低檔是止跌訊號 */
function isDragonflyDoji(c: CandleWithIndicators): boolean {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range <= 0) return false;
  const upperShadow = c.high - Math.max(c.close, c.open);
  const lowerShadow = Math.min(c.close, c.open) - c.low;
  return lowerShadow / range > 0.6 && (body + upperShadow) / range < 0.3;
}

/** 天劍線（shooting star）：長上影線 > 實體2倍，下影線極短 */
function isShootingStar(c: CandleWithIndicators): boolean {
  const body = Math.abs(c.close - c.open);
  const upperShadow = c.high - Math.max(c.close, c.open);
  const lowerShadow = Math.min(c.close, c.open) - c.low;
  if (body <= 0) return false;
  return upperShadow >= body * 2 && lowerShadow <= body * 0.3;
}

/** 蜻蜓線（hammer / dragonfly）：長下影線 > 實體2倍，上影線極短 */
function isHammer(c: CandleWithIndicators): boolean {
  const body = Math.abs(c.close - c.open);
  const upperShadow = c.high - Math.max(c.close, c.open);
  const lowerShadow = Math.min(c.close, c.open) - c.low;
  if (body <= 0) return false;
  return lowerShadow >= body * 2 && upperShadow <= body * 0.3;
}

/** 紡錘線（spinning top）：實體小，上下影線都長 */
function isSpinningTop(c: CandleWithIndicators): boolean {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range <= 0) return false;
  const upperShadow = c.high - Math.max(c.close, c.open);
  const lowerShadow = Math.min(c.close, c.open) - c.low;
  return body / range < 0.3 && upperShadow / range > 0.2 && lowerShadow / range > 0.2;
}

/** 是否為中長黑K（實體 > 2%） */
function isMidLongBlack(c: CandleWithIndicators): boolean {
  return c.close < c.open && bodyPct(c) > 0.02;
}

/** 是否為中長紅K（實體 > 2%） */
function isMidLongRed(c: CandleWithIndicators): boolean {
  return c.close > c.open && bodyPct(c) > 0.02;
}

/** 是否爆量（> 前日2倍 或 > 5日均量2倍） */
function isVolumeBlast(c: CandleWithIndicators, prev: CandleWithIndicators): boolean {
  if (c.volume == null || prev.volume == null) return false;
  const vsPrev = prev.volume > 0 && c.volume >= prev.volume * 2;
  const vsAvg = c.avgVol5 != null && c.avgVol5 > 0 && c.volume >= c.avgVol5 * 2;
  return vsPrev || vsAvg;
}

/** KD 高檔背離：股價頭頭高，K值頭頭低 */
function kdHighDivergence(candles: CandleWithIndicators[], index: number): boolean {
  if (index < 10) return false;
  const c = candles[index];
  if (c.kdK == null) return false;
  // 往回找最近的高點及其KD
  for (let i = index - 5; i >= index - 20 && i >= 0; i--) {
    const p = candles[i];
    if (p.kdK == null) continue;
    if (p.high >= c.high * 0.98 && p.high < c.high && p.kdK > c.kdK) {
      return true; // 股價新高但 KD 更低
    }
  }
  return false;
}

/** KD 低檔背離：股價底底低，K值底底高 */
function kdLowDivergence(candles: CandleWithIndicators[], index: number): boolean {
  if (index < 10) return false;
  const c = candles[index];
  if (c.kdK == null) return false;
  for (let i = index - 5; i >= index - 20 && i >= 0; i--) {
    const p = candles[i];
    if (p.kdK == null) continue;
    if (p.low <= c.low * 1.02 && p.low > c.low && p.kdK < c.kdK) {
      return true; // 股價新低但 KD 更高
    }
  }
  return false;
}

/** MACD 高檔背離：股價頭頭高，柱狀體頭頭低 */
function macdHighDivergence(candles: CandleWithIndicators[], index: number): boolean {
  if (index < 10) return false;
  const c = candles[index];
  if (c.macdOSC == null) return false;
  for (let i = index - 5; i >= index - 20 && i >= 0; i--) {
    const p = candles[i];
    if (p.macdOSC == null) continue;
    if (p.high >= c.high * 0.98 && p.high < c.high && p.macdOSC > c.macdOSC) {
      return true;
    }
  }
  return false;
}

/** MACD 低檔背離：股價底底低，柱狀體底底高 */
function macdLowDivergence(candles: CandleWithIndicators[], index: number): boolean {
  if (index < 10) return false;
  const c = candles[index];
  if (c.macdOSC == null) return false;
  for (let i = index - 5; i >= index - 20 && i >= 0; i--) {
    const p = candles[i];
    if (p.macdOSC == null) continue;
    if (p.low <= c.low * 1.02 && p.low > c.low && p.macdOSC < c.macdOSC) {
      return true;
    }
  }
  return false;
}

/** 高檔爆量後3日不創新高 */
function blastVolumeNoNewHigh(candles: CandleWithIndicators[], index: number): boolean {
  if (index < 4) return false;
  // 往回找3日內是否有爆量日
  for (let d = 1; d <= 3; d++) {
    const blast = candles[index - d];
    const beforeBlast = index - d - 1 >= 0 ? candles[index - d - 1] : null;
    if (beforeBlast == null) continue;
    if (isVolumeBlast(blast, beforeBlast)) {
      // 爆量後到現在都沒再創新高
      const blastHigh = blast.high;
      let noNewHigh = true;
      for (let j = index - d + 1; j <= index; j++) {
        if (candles[j].high > blastHigh) { noNewHigh = false; break; }
      }
      if (noNewHigh) return true;
    }
  }
  return false;
}

/** 低檔爆量後3日不創新低 */
function blastVolumeNoNewLow(candles: CandleWithIndicators[], index: number): boolean {
  if (index < 4) return false;
  for (let d = 1; d <= 3; d++) {
    const blast = candles[index - d];
    const beforeBlast = index - d - 1 >= 0 ? candles[index - d - 1] : null;
    if (beforeBlast == null) continue;
    if (isVolumeBlast(blast, beforeBlast)) {
      const blastLow = blast.low;
      let noNewLow = true;
      for (let j = index - d + 1; j <= index; j++) {
        if (candles[j].low < blastLow) { noNewLow = false; break; }
      }
      if (noNewLow) return true;
    }
  }
  return false;
}

// ── Rule 7: 高檔變盤訊號 ─────────────────────────────────────────────────────

export const sopHighReversalWarning: TradingRule = {
  id: 'sop-high-reversal-warning',
  name: '走圖SOP｜高檔變盤訊號',
  description: '多頭高檔出現變盤線/大量黑K/背離訊號，多單準備停利',

  evaluate(candles: CandleWithIndicators[], index: number): RuleSignal | null {
    if (index < MIN_BARS) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 必須在高檔位置（主升段或末升段）
    const pos = detectTrendPosition(candles, index);
    if (pos !== '主升段' && pos !== '末升段(高檔)') return null;

    // 收集觸發的訊號
    const signals: string[] = [];

    // K棒訊號（更專一的型態優先：倒T/天劍 比一般「十字變盤」更精確）
    if (isMidLongBlack(c) && isVolumeBlast(c, prev)) {
      signals.push('大量中長黑K');
    }
    if (isGravestoneDoji(c)) signals.push('倒T變盤線');
    else if (isDoji(c)) signals.push('十字變盤線');  // gravestone 已涵蓋十字，避免重複
    if (isShootingStar(c)) signals.push('天劍線');
    if (isSpinningTop(c)) signals.push('紡錘線');

    // 背離訊號
    if (kdHighDivergence(candles, index)) signals.push('KD高檔背離');
    if (macdHighDivergence(candles, index)) signals.push('MACD高檔背離');

    // 爆量後不創新高
    if (blastVolumeNoNewHigh(candles, index)) signals.push('爆量後3日不創新高');

    // 至少要有1個訊號
    if (signals.length === 0) return null;

    return {
      type: 'REDUCE',
      label: '走圖SOP高檔變盤',
      description: `高檔訊號：${signals.join('、')}`,
      reason: `多頭高檔出現變盤訊號（${signals.join('、')}），主力可能正在出貨。手上持有多單應準備停利出場。若獲利已超過10%目標且出現黑K跌破5MA，當日收盤出場。`,
      ruleId: 'sop-high-reversal-warning',
    };
  },
};

// ── Rule 8: 低檔變盤訊號 ─────────────────────────────────────────────────────

export const sopLowReversalSignal: TradingRule = {
  id: 'sop-low-reversal-signal',
  name: '走圖SOP｜低檔變盤訊號',
  description: '空頭低檔出現變盤線/大量紅K/背離訊號，空單準備停利',

  evaluate(candles: CandleWithIndicators[], index: number): RuleSignal | null {
    if (index < MIN_BARS) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 必須在低檔位置（主跌段或末跌段）
    const pos = detectTrendPosition(candles, index);
    if (pos !== '主跌段' && pos !== '末跌段(低檔)') return null;

    // 收集觸發的訊號
    const signals: string[] = [];

    // K棒訊號（更專一型態優先：T字 比一般「十字變盤」更精確）
    if (isMidLongRed(c) && isVolumeBlast(c, prev)) {
      signals.push('大量中長紅K');
    }
    if (isDragonflyDoji(c)) signals.push('T字變盤線');
    else if (isDoji(c)) signals.push('十字變盤線');  // dragonfly 已涵蓋十字
    if (isHammer(c)) signals.push('蜻蜓線');
    if (isSpinningTop(c)) signals.push('紡錘線');

    // 背離訊號
    if (kdLowDivergence(candles, index)) signals.push('KD低檔背離');
    if (macdLowDivergence(candles, index)) signals.push('MACD低檔背離');

    // 爆量後不創新低
    if (blastVolumeNoNewLow(candles, index)) signals.push('爆量後3日不創新低');

    // 至少要有1個訊號
    if (signals.length === 0) return null;

    return {
      type: 'REDUCE',
      label: '走圖SOP低檔變盤',
      description: `低檔訊號：${signals.join('、')}`,
      reason: `空頭低檔出現變盤訊號（${signals.join('、')}），空頭趨勢即將止跌打底。手上持有空單應準備停利出場。若獲利已超過10%目標且出現紅K站上5MA，當日收盤出場。`,
      ruleId: 'sop-low-reversal-signal',
    };
  },
};
