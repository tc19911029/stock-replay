/**
 * Volatility Regime Detection
 *
 * Classifies the current volatility environment to adapt strategy parameters:
 * - LOW: Tight range, compression → breakout setups are reliable, tight stops OK
 * - NORMAL: Standard conditions → use default parameters
 * - HIGH: Expanded range, wild swings → need wider stops, shorter holds
 * - EXTREME: Crisis/euphoria levels → very cautious, reduce position size
 *
 * Uses:
 * - ATR percentile vs historical ATR
 * - Bollinger Band width (relative to MA20)
 * - Daily range compression/expansion
 */

import { CandleWithIndicators } from '@/types';

export type VolatilityRegime = 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';

export interface VolatilityRegimeResult {
  regime: VolatilityRegime;
  /** 0-100: current volatility percentile (0=lowest, 100=highest) */
  percentile: number;
  /** Adjustment multiplier for stop-loss width (0.7 = tighter, 1.5 = wider) */
  stopAdjust: number;
  /** Adjustment for hold days (0.7 = shorter, 1.3 = longer) */
  holdAdjust: number;
  /** Position size multiplier (0.5 = half size in extreme vol) */
  sizeAdjust: number;
  detail: string;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Detect current volatility regime from price data.
 */
export function detectVolatilityRegime(
  candles: CandleWithIndicators[],
  idx: number,
): VolatilityRegimeResult {
  if (idx < 40) {
    return { regime: 'NORMAL', percentile: 50, stopAdjust: 1.0, holdAdjust: 1.0, sizeAdjust: 1.0, detail: 'insufficient data' };
  }

  const details: string[] = [];

  // ── 1. ATR-based volatility percentile ─────────────────────────────────
  // Calculate 14-day ATR for recent and historical comparison
  const atrWindow = 14;
  const atrValues: number[] = [];

  for (let i = Math.max(atrWindow, idx - 120); i <= idx; i++) {
    let atrSum = 0;
    for (let j = i - atrWindow + 1; j <= i; j++) {
      if (j < 1) continue;
      const c = candles[j];
      const prev = candles[j - 1];
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close),
      );
      atrSum += tr;
    }
    atrValues.push(atrSum / atrWindow);
  }

  const currentATR = atrValues[atrValues.length - 1] ?? 0;
  const sortedATR = [...atrValues].sort((a, b) => a - b);
  const atrPercentile = sortedATR.length > 0
    ? (sortedATR.findIndex(v => v >= currentATR) / sortedATR.length) * 100
    : 50;

  // ── 2. Bollinger Band width (volatility squeeze) ──────────────────────
  let bbWidthPct = 0;
  const c = candles[idx];
  if (c.ma20 && c.ma20 > 0) {
    // Calculate 20-day std dev
    let sumSq = 0;
    let count = 0;
    for (let i = idx - 19; i <= idx; i++) {
      if (i < 0) continue;
      const diff = candles[i].close - c.ma20;
      sumSq += diff * diff;
      count++;
    }
    if (count > 0) {
      const stdDev = Math.sqrt(sumSq / count);
      bbWidthPct = (stdDev * 2 / c.ma20) * 100; // BB width as % of MA20
    }
  }

  // ── 3. Recent daily range vs historical ────────────────────────────────
  let recentAvgRange = 0;
  let histAvgRange = 0;
  for (let i = idx - 4; i <= idx; i++) {
    if (i < 0) continue;
    recentAvgRange += (candles[i].high - candles[i].low) / candles[i].close * 100;
  }
  recentAvgRange /= 5;

  for (let i = idx - 24; i <= idx - 5; i++) {
    if (i < 0) continue;
    histAvgRange += (candles[i].high - candles[i].low) / candles[i].close * 100;
  }
  histAvgRange /= 20;

  const rangeRatio = histAvgRange > 0 ? recentAvgRange / histAvgRange : 1;

  // ── 4. Classify regime ─────────────────────────────────────────────────
  const percentile = clamp(Math.round(atrPercentile), 0, 100);

  let regime: VolatilityRegime;
  let stopAdjust: number;
  let holdAdjust: number;
  let sizeAdjust: number;

  if (percentile >= 90 || rangeRatio > 2.0) {
    regime = 'EXTREME';
    stopAdjust = 1.5;   // much wider stops
    holdAdjust = 0.6;   // shorter holds
    sizeAdjust = 0.5;   // half position size
    details.push(`ATR P${percentile}`, `range ${rangeRatio.toFixed(1)}x`);
  } else if (percentile >= 70 || rangeRatio > 1.4) {
    regime = 'HIGH';
    stopAdjust = 1.25;
    holdAdjust = 0.8;
    sizeAdjust = 0.75;
    details.push(`ATR P${percentile}`);
  } else if (percentile <= 20 || (bbWidthPct > 0 && bbWidthPct < 3)) {
    regime = 'LOW';
    stopAdjust = 0.75;  // tighter stops (less noise)
    holdAdjust = 1.2;   // can hold longer (less choppy)
    sizeAdjust = 1.1;   // slightly larger size (breakouts are clean)
    details.push(`ATR P${percentile}`, bbWidthPct > 0 ? `BB width ${bbWidthPct.toFixed(1)}%` : '');
  } else {
    regime = 'NORMAL';
    stopAdjust = 1.0;
    holdAdjust = 1.0;
    sizeAdjust = 1.0;
    details.push(`ATR P${percentile}`);
  }

  return {
    regime,
    percentile,
    stopAdjust,
    holdAdjust,
    sizeAdjust,
    detail: details.filter(Boolean).join(', '),
  };
}
