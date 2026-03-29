/**
 * Trend Acceleration Detection
 *
 * Measures whether a trend is accelerating or decelerating.
 * Key insight: an accelerating trend (slope of moving averages increasing)
 * has more upside; a decelerating trend (slope flattening) signals exhaustion.
 *
 * Uses:
 * - MA slope rate of change: d(MA)/dt is increasing or decreasing
 * - ADX-like momentum: strength of directional movement
 * - Price vs MA envelope width: expanding = accelerating, narrowing = decelerating
 */

import { CandleWithIndicators } from '@/types';

export interface TrendAccelerationResult {
  /** -100 (strongly decelerating) to +100 (strongly accelerating) */
  acceleration: number;
  /** Classification for strategy decisions */
  phase: 'accelerating' | 'steady' | 'decelerating' | 'reversing';
  detail: string;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Compute trend acceleration from candle data.
 * Returns acceleration score and phase classification.
 */
export function computeTrendAcceleration(
  candles: CandleWithIndicators[],
  idx: number,
): TrendAccelerationResult {
  if (idx < 25) {
    return { acceleration: 0, phase: 'steady', detail: 'insufficient data' };
  }

  const details: string[] = [];
  let accelScore = 0;

  // ── 1. MA20 slope acceleration ───────────────────────────────────────────
  // Compare recent MA20 slope vs earlier MA20 slope
  const ma20Now = candles[idx].ma20;
  const ma20_5 = candles[idx - 5]?.ma20;
  const ma20_10 = candles[idx - 10]?.ma20;
  const ma20_15 = candles[idx - 15]?.ma20;

  if (ma20Now != null && ma20_5 != null && ma20_10 != null && ma20_15 != null && ma20_15 > 0) {
    const recentSlope = (ma20Now - ma20_5) / ma20_15 * 100;  // % change last 5 days
    const prevSlope = (ma20_10 - ma20_15) / ma20_15 * 100;   // % change 10-15 days ago

    const slopeChange = recentSlope - prevSlope;
    if (slopeChange > 1.5) { accelScore += 40; details.push('MA20 accelerating fast'); }
    else if (slopeChange > 0.5) { accelScore += 25; details.push('MA20 accelerating'); }
    else if (slopeChange > -0.5) { /* steady */ }
    else if (slopeChange > -1.5) { accelScore -= 25; details.push('MA20 decelerating'); }
    else { accelScore -= 40; details.push('MA20 decelerating fast'); }
  }

  // ── 2. Price-MA envelope width change ─────────────────────────────────────
  // Expanding envelope = trend gaining strength
  if (ma20Now != null && ma20_10 != null && ma20Now > 0 && ma20_10 > 0) {
    const envNow = Math.abs(candles[idx].close - ma20Now) / ma20Now;
    const env10 = Math.abs(candles[idx - 10].close - ma20_10) / ma20_10;
    const envChange = envNow - env10;

    // Is price moving away from MA (accelerating) or converging (decelerating)?
    const priceAboveMA = candles[idx].close > ma20Now;
    if (priceAboveMA && envChange > 0.02) {
      accelScore += 20; details.push('envelope expanding');
    } else if (priceAboveMA && envChange < -0.02) {
      accelScore -= 20; details.push('envelope contracting');
    }
  }

  // ── 3. ROC acceleration ──────────────────────────────────────────────────
  // 5-day ROC vs 10-day ROC (half period): accelerating if short > long/2
  const close5 = candles[idx - 5]?.close;
  const close10 = candles[idx - 10]?.close;
  const closeNow = candles[idx].close;
  if (close5 && close10 && close5 > 0 && close10 > 0) {
    const roc5 = (closeNow - close5) / close5 * 100;
    const roc10 = (closeNow - close10) / close10 * 100;
    const halfRoc10 = roc10 / 2;

    if (roc5 > halfRoc10 + 1) {
      accelScore += 20; details.push('ROC accelerating');
    } else if (roc5 < halfRoc10 - 1) {
      accelScore -= 20; details.push('ROC decelerating');
    }
  }

  // ── 4. Volume confirmation ───────────────────────────────────────────────
  // Volume should increase with acceleration, decrease with deceleration
  const c = candles[idx];
  if (c.avgVol5 && c.avgVol5 > 0) {
    let recentVolTrend = 0;
    for (let i = idx - 4; i <= idx; i++) {
      if (i > 0 && candles[i].volume > candles[i - 1].volume) recentVolTrend++;
    }
    if (accelScore > 0 && recentVolTrend >= 3) {
      accelScore += 15; details.push('vol confirms acceleration');
    } else if (accelScore > 0 && recentVolTrend <= 1) {
      accelScore -= 10; details.push('vol diverges from acceleration');
    }
  }

  const acceleration = clamp(accelScore, -100, 100);

  let phase: TrendAccelerationResult['phase'];
  if (acceleration >= 30) phase = 'accelerating';
  else if (acceleration >= -15) phase = 'steady';
  else if (acceleration >= -50) phase = 'decelerating';
  else phase = 'reversing';

  return {
    acceleration,
    phase,
    detail: details.join(', ') || 'neutral',
  };
}
