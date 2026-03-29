/**
 * Relative Strength Analysis
 *
 * Compares a stock's recent performance to the overall market.
 * Stocks that outperform the market during pullbacks are exhibiting
 * "relative strength" — a sign of institutional demand.
 *
 * Research basis:
 * - Mansfield Relative Strength: stocks in the top quartile of RS
 *   outperform the bottom quartile by 10-15% annually
 * - During market corrections, RS leaders tend to recover first and fastest
 * - RS divergence (stock strong while market weak) = accumulation signal
 *
 * Implementation:
 * - Compare stock's N-day ROC to its own 60-day history
 * - Detect RS divergence: stock holding support while making higher lows
 * - Bonus for stocks making new highs when market isn't
 */

import { CandleWithIndicators } from '@/types';

export interface RelativeStrengthResult {
  /** Relative strength score: 0-100 */
  rsScore: number;
  /** Classification */
  rsRank: 'LEADER' | 'STRONG' | 'NEUTRAL' | 'WEAK' | 'LAGGARD';
  /** Composite score adjustment */
  compositeAdjust: number;
  detail: string;
}

/**
 * Compute relative strength using only the stock's own data.
 * Since we don't have market index data per-stock, we use
 * self-referential RS: how strong is current momentum vs recent history.
 */
export function computeRelativeStrength(
  candles: CandleWithIndicators[],
  idx: number,
): RelativeStrengthResult {
  if (idx < 60) {
    return { rsScore: 50, rsRank: 'NEUTRAL', compositeAdjust: 0, detail: 'insufficient data' };
  }

  const details: string[] = [];
  let score = 50; // start neutral

  const close = candles[idx].close;

  // ── 1. Multi-period momentum rank ───────────────────────────────────────
  // Compare current returns at different lookback periods
  const periods = [5, 10, 20, 60];
  let totalMomScore = 0;

  for (const p of periods) {
    if (idx < p) continue;
    const pastClose = candles[idx - p].close;
    if (pastClose <= 0) continue;
    const roc = ((close - pastClose) / pastClose) * 100;

    // Score each period's ROC
    if (roc > 15) totalMomScore += 4;
    else if (roc > 8) totalMomScore += 3;
    else if (roc > 3) totalMomScore += 2;
    else if (roc > 0) totalMomScore += 1;
    else if (roc > -3) totalMomScore += 0;
    else if (roc > -8) totalMomScore -= 1;
    else totalMomScore -= 2;
  }

  // Normalize to 0-100
  // Range: -8 to +16
  score += Math.round((totalMomScore / 16) * 30);

  // ── 2. Higher lows pattern (relative strength during pullbacks) ─────────
  // Count how many of the last 3 pullback lows are higher than the previous
  let higherLows = 0;
  let lastLow = Infinity;
  for (let i = idx - 20; i <= idx; i++) {
    if (i < 1) continue;
    const c = candles[i];
    const prev = candles[i - 1];
    // Detect local low: lower than neighbors
    if (i < idx && c.low < prev.low && c.low < candles[i + 1].low) {
      if (c.low > lastLow) higherLows++;
      lastLow = c.low;
    }
  }

  if (higherLows >= 2) {
    score += 10;
    details.push('higher lows pattern');
  }

  // ── 3. New high proximity ──────────────────────────────────────────────
  // How close is current price to its 60-day high?
  let high60 = 0;
  for (let i = Math.max(0, idx - 60); i <= idx; i++) {
    if (candles[i].high > high60) high60 = candles[i].high;
  }

  if (high60 > 0) {
    const distFromHigh = (high60 - close) / high60;
    if (distFromHigh < 0.02) {
      score += 10; // within 2% of 60d high
      details.push('near 60d high');
    } else if (distFromHigh < 0.05) {
      score += 5;
    } else if (distFromHigh > 0.15) {
      score -= 5;
    }
  }

  // ── 4. MA alignment strength ──────────────────────────────────────────
  const c = candles[idx];
  const maAligned = c.ma5 != null && c.ma10 != null && c.ma20 != null
    && c.ma5 > c.ma10 && c.ma10 > c.ma20;
  if (maAligned) {
    score += 5;
    details.push('MA aligned');
  }

  // Clamp to 0-100
  const rsScore = Math.max(0, Math.min(100, score));

  // Classify
  let rsRank: RelativeStrengthResult['rsRank'];
  let compositeAdjust: number;

  if (rsScore >= 80) {
    rsRank = 'LEADER';
    compositeAdjust = 8;
  } else if (rsScore >= 65) {
    rsRank = 'STRONG';
    compositeAdjust = 4;
  } else if (rsScore >= 40) {
    rsRank = 'NEUTRAL';
    compositeAdjust = 0;
  } else if (rsScore >= 25) {
    rsRank = 'WEAK';
    compositeAdjust = -4;
  } else {
    rsRank = 'LAGGARD';
    compositeAdjust = -8;
  }

  return {
    rsScore,
    rsRank,
    compositeAdjust,
    detail: details.join(', ') || `RS ${rsScore}`,
  };
}
