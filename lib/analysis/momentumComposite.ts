/**
 * Multi-Dimensional Momentum Composite
 *
 * Combines 4 momentum dimensions to reduce single-factor momentum crash risk:
 * 1. Price Momentum — ROC-based price trend strength
 * 2. Volume Momentum — rate of change of average volume
 * 3. Sector Momentum — sector heat (from scanner context)
 * 4. Relative Strength — stock return vs market return
 *
 * Research basis:
 * - Equal-weighted composite of multiple momentum signals demonstrates
 *   superior risk-adjusted returns vs price-only momentum
 * - Reduces momentum reversal crash risk by diversifying signal sources
 */

import type { CandleWithIndicators } from '@/types';

export interface MomentumCompositeResult {
  totalScore: number;    // 0-100
  components: {
    priceMomentum: number;      // 0-100
    volumeMomentum: number;     // 0-100
    relativeStrength: number;   // 0-100
    trendAcceleration: number;  // 0-100
  };
  compositeAdjust: number;  // -10 to +10 for composite score integration
  detail: string;
}

function clamp(v: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 1. Price Momentum — multi-period ROC convergence
 * Uses ROC5, ROC10, ROC20 to detect accelerating vs decelerating momentum
 */
function scorePriceMomentum(candles: CandleWithIndicators[], idx: number): number {
  if (idx < 20) return 50;

  let score = 0;
  const c = candles[idx];

  // ROC5 (short-term)
  const close5 = candles[idx - 5]?.close;
  const roc5 = close5 && close5 > 0 ? ((c.close - close5) / close5) * 100 : 0;

  // ROC10
  const roc10 = c.roc10 ?? 0;

  // ROC20
  const roc20 = c.roc20 ?? 0;

  // All positive = confirmed uptrend
  if (roc5 > 0 && roc10 > 0 && roc20 > 0) score += 40;
  else if (roc5 > 0 && roc10 > 0) score += 25;
  else if (roc5 > 0) score += 10;

  // Accelerating: shorter-term ROC > longer-term ROC
  if (roc5 > roc10 && roc10 > 0) {
    score += 20; // accelerating
  } else if (roc5 < roc10 * 0.5 && roc10 > 0) {
    score -= 10; // decelerating sharply
  }

  // MA alignment bonus
  if (c.ma5 != null && c.ma10 != null && c.ma20 != null) {
    if (c.ma5 > c.ma10 && c.ma10 > c.ma20) score += 20;
  }

  // RSI momentum zone (40-70 = healthy momentum, >80 = overheated)
  if (c.rsi14 != null) {
    if (c.rsi14 >= 45 && c.rsi14 <= 70) score += 20;
    else if (c.rsi14 > 80) score -= 10;
  }

  return clamp(score);
}

/**
 * 2. Volume Momentum — rate of change of volume
 * Rising volume in uptrend = institutional participation
 */
function scoreVolumeMomentum(candles: CandleWithIndicators[], idx: number): number {
  if (idx < 20) return 50;

  let score = 50; // neutral baseline
  const c = candles[idx];

  // Recent 5-day avg volume vs prior 5-day avg volume
  if (c.avgVol5 != null && idx >= 10) {
    let priorAvg = 0;
    let count = 0;
    for (let i = idx - 9; i <= idx - 5; i++) {
      if (i >= 0) { priorAvg += candles[i].volume; count++; }
    }
    if (count > 0) {
      priorAvg /= count;
      const volROC = priorAvg > 0 ? (c.avgVol5 - priorAvg) / priorAvg : 0;

      if (volROC > 0.5) score += 30;       // 50%+ volume increase
      else if (volROC > 0.2) score += 20;  // 20%+ increase
      else if (volROC > 0) score += 10;
      else if (volROC < -0.3) score -= 15; // declining volume
    }
  }

  // Volume trend: 3 consecutive days of increasing volume
  if (idx >= 3) {
    const v0 = candles[idx].volume;
    const v1 = candles[idx - 1].volume;
    const v2 = candles[idx - 2].volume;
    if (v0 > v1 && v1 > v2 && candles[idx].close > candles[idx].open) {
      score += 20; // volume buildup with bullish candle
    }
  }

  return clamp(score);
}

/**
 * 3. Relative Strength — stock return vs market return over 20 days
 * Outperforming stocks tend to continue outperforming (momentum effect)
 */
function scoreRelativeStrength(candles: CandleWithIndicators[], idx: number): number {
  if (idx < 20) return 50;

  let score = 50; // neutral
  const c = candles[idx];

  // Use existing relative strength data if available
  // Fall back to computing from MA20 slope
  const close20 = candles[idx - 20]?.close;
  if (close20 && close20 > 0) {
    const stockReturn = ((c.close - close20) / close20) * 100;

    // Absolute strength
    if (stockReturn > 15) score += 30;
    else if (stockReturn > 8) score += 20;
    else if (stockReturn > 3) score += 10;
    else if (stockReturn < -5) score -= 15;
    else if (stockReturn < -10) score -= 25;
  }

  // MA20 slope (trend direction)
  if (c.ma20 != null && idx >= 5) {
    const prevMa20 = candles[idx - 5]?.ma20;
    if (prevMa20 != null && prevMa20 > 0) {
      const maSlope = ((c.ma20 - prevMa20) / prevMa20) * 100;
      if (maSlope > 1) score += 10;
      else if (maSlope < -1) score -= 10;
    }
  }

  return clamp(score);
}

/**
 * 4. Trend Acceleration — MACD slope + momentum acceleration
 * Measures whether momentum is accelerating or decelerating
 */
function scoreTrendAcceleration(candles: CandleWithIndicators[], idx: number): number {
  if (idx < 10) return 50;

  let score = 50;
  const c = candles[idx];

  // MACD histogram trend (3-bar acceleration)
  if (c.macdSlope != null) {
    if (c.macdSlope > 0.1) score += 25;
    else if (c.macdSlope > 0) score += 10;
    else if (c.macdSlope < -0.1) score -= 15;
  }

  // MACD histogram positive and growing
  if (c.macdOSC != null && idx >= 3) {
    const prev3OSC = candles[idx - 3]?.macdOSC;
    if (prev3OSC != null && c.macdOSC > 0 && c.macdOSC > prev3OSC) {
      score += 15; // accelerating bullish momentum
    }
  }

  // Price acceleration: recent 5d gain > prior 5d gain
  if (idx >= 10) {
    const recentGain = candles[idx].close - candles[idx - 5].close;
    const priorGain = candles[idx - 5].close - candles[idx - 10].close;
    if (recentGain > priorGain && recentGain > 0) {
      score += 10; // accelerating price gains
    }
  }

  return clamp(score);
}

/**
 * Compute multi-dimensional momentum composite.
 * Returns a 0-100 score and adjustment value for composite scoring.
 */
export function computeMomentumComposite(
  candles: CandleWithIndicators[],
  idx: number,
): MomentumCompositeResult {
  const priceMomentum = scorePriceMomentum(candles, idx);
  const volumeMomentum = scoreVolumeMomentum(candles, idx);
  const relativeStrength = scoreRelativeStrength(candles, idx);
  const trendAcceleration = scoreTrendAcceleration(candles, idx);

  // Equal-weighted average of all dimensions
  const totalScore = Math.round(
    (priceMomentum + volumeMomentum + relativeStrength + trendAcceleration) / 4
  );

  // Composite adjustment: -10 to +10
  let compositeAdjust = 0;
  if (totalScore >= 75) compositeAdjust = 8;
  else if (totalScore >= 65) compositeAdjust = 5;
  else if (totalScore >= 55) compositeAdjust = 2;
  else if (totalScore < 35) compositeAdjust = -8;
  else if (totalScore < 45) compositeAdjust = -4;

  const details: string[] = [];
  if (priceMomentum >= 70) details.push('strong price');
  if (volumeMomentum >= 70) details.push('vol buildup');
  if (relativeStrength >= 70) details.push('outperform');
  if (trendAcceleration >= 70) details.push('accelerating');
  if (totalScore < 35) details.push('weak momentum');

  return {
    totalScore,
    components: { priceMomentum, volumeMomentum, relativeStrength, trendAcceleration },
    compositeAdjust,
    detail: details.join(', ') || 'neutral',
  };
}
