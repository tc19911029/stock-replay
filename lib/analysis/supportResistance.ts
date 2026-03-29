/**
 * Support/Resistance Proximity Analysis
 *
 * Detects nearby support and resistance levels to improve entry quality:
 * - Entry near support → better risk/reward (tight stop, large upside)
 * - Entry near resistance → higher risk (may reject)
 * - Breakout above resistance with volume → strong continuation signal
 *
 * Methods:
 * 1. Recent swing highs/lows as S/R levels
 * 2. Round number levels (psychological barriers)
 * 3. Moving average clusters as dynamic S/R
 */

import { CandleWithIndicators } from '@/types';

export interface SupportResistanceResult {
  /** -20 to +20: positive = favorable position (near support or breakout), negative = near resistance */
  proximityScore: number;
  nearestSupport: number | null;
  nearestResistance: number | null;
  /** Whether price just broke above a key resistance level */
  breakoutDetected: boolean;
  detail: string;
}

/**
 * Analyze support/resistance proximity for entry quality assessment.
 */
export function analyzeSupportResistance(
  candles: CandleWithIndicators[],
  idx: number,
): SupportResistanceResult {
  if (idx < 30) {
    return { proximityScore: 0, nearestSupport: null, nearestResistance: null, breakoutDetected: false, detail: 'insufficient data' };
  }

  const c = candles[idx];
  const price = c.close;
  const details: string[] = [];
  let score = 0;

  // ── 1. Find swing highs/lows as S/R levels ──────────────────────────────
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  const lookback = Math.min(idx, 60);

  for (let i = idx - lookback + 2; i < idx - 1; i++) {
    if (i < 1) continue;
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Swing high: higher high than neighbors
    if (curr.high > prev.high && curr.high > next.high) {
      swingHighs.push(curr.high);
    }
    // Swing low: lower low than neighbors
    if (curr.low < prev.low && curr.low < next.low) {
      swingLows.push(curr.low);
    }
  }

  // Find nearest support (below price) and resistance (above price)
  let nearestSupport: number | null = null;
  let nearestResistance: number | null = null;

  for (const low of swingLows) {
    if (low < price && (nearestSupport === null || low > nearestSupport)) {
      nearestSupport = low;
    }
  }
  for (const high of swingHighs) {
    if (high > price && (nearestResistance === null || high < nearestResistance)) {
      nearestResistance = high;
    }
  }

  // ── 2. MA cluster as dynamic S/R ──────────────────────────────────────
  const maLevels = [c.ma5, c.ma10, c.ma20, c.ma60].filter((m): m is number => m != null && m > 0);
  const maSupportLevels = maLevels.filter(m => m < price && m > price * 0.95);
  const maResistanceLevels = maLevels.filter(m => m > price && m < price * 1.05);

  // ── 3. Score proximity ──────────────────────────────────────────────────

  // Near support (within 2% of swing low or MA support): favorable
  if (nearestSupport !== null) {
    const distToSupport = (price - nearestSupport) / price;
    if (distToSupport < 0.02) {
      score += 10;
      details.push(`near swing support ${nearestSupport.toFixed(0)}`);
    } else if (distToSupport < 0.05) {
      score += 5;
    }
  }

  // MA support cluster: multiple MAs converging below = strong support
  if (maSupportLevels.length >= 2) {
    score += 8;
    details.push(`${maSupportLevels.length} MA supports nearby`);
  } else if (maSupportLevels.length === 1) {
    score += 3;
  }

  // Near resistance (within 2%): risky unless breaking out
  if (nearestResistance !== null) {
    const distToResistance = (nearestResistance - price) / price;
    if (distToResistance < 0.02) {
      // Check if this is a breakout (volume surge + closing near high)
      const volRatio = c.avgVol5 && c.avgVol5 > 0 ? c.volume / c.avgVol5 : 1;
      const closeNearHigh = c.high > 0 ? (c.close - c.low) / (c.high - c.low) : 0.5;

      if (volRatio > 1.5 && closeNearHigh > 0.7) {
        score += 15;
        details.push('resistance breakout with volume');
      } else {
        score -= 10;
        details.push(`near resistance ${nearestResistance.toFixed(0)}`);
      }
    }
  }

  // MA resistance cluster: headwind
  if (maResistanceLevels.length >= 2) {
    score -= 8;
    details.push('MA resistance cluster above');
  }

  // ── 4. Breakout detection ──────────────────────────────────────────────
  // Price closing above the highest swing high in last 20 days = breakout
  let breakoutDetected = false;
  const recentHighs = swingHighs.filter(h => h > 0);
  if (recentHighs.length > 0) {
    const maxRecentHigh = Math.max(...recentHighs);
    if (price > maxRecentHigh) {
      const volRatio = c.avgVol5 && c.avgVol5 > 0 ? c.volume / c.avgVol5 : 1;
      if (volRatio > 1.3) {
        breakoutDetected = true;
        score += 10;
        details.push('breakout above recent highs');
      }
    }
  }

  return {
    proximityScore: Math.max(-20, Math.min(20, score)),
    nearestSupport,
    nearestResistance,
    breakoutDetected,
    detail: details.join(', ') || 'neutral',
  };
}
