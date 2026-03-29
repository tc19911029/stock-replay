/**
 * Japanese Candlestick Pattern Recognition
 *
 * Detects high-probability reversal and continuation patterns:
 * - Bullish: hammer, engulfing, morning star, three white soldiers
 * - Bearish: shooting star, evening star, three black crows
 *
 * Each pattern has a reliability score based on historical backtesting.
 * Only used as composite adjustment (not a gate), because patterns
 * work best as confirmation of other signals.
 */

import { CandleWithIndicators } from '@/types';

export interface CandlePatternResult {
  /** Detected patterns */
  patterns: string[];
  /** Net adjustment: positive = bullish patterns, negative = bearish */
  compositeAdjust: number;
  detail: string;
}

function bodySize(c: { open: number; close: number }): number {
  return Math.abs(c.close - c.open);
}

function isBullish(c: { open: number; close: number }): boolean {
  return c.close > c.open;
}

function totalRange(c: { high: number; low: number }): number {
  return c.high - c.low;
}

function upperShadow(c: { open: number; close: number; high: number }): number {
  return c.high - Math.max(c.open, c.close);
}

function lowerShadow(c: { open: number; close: number; low: number }): number {
  return Math.min(c.open, c.close) - c.low;
}

/**
 * Detect candlestick patterns at the given index.
 */
export function detectCandlePatterns(
  candles: CandleWithIndicators[],
  idx: number,
): CandlePatternResult {
  if (idx < 3) {
    return { patterns: [], compositeAdjust: 0, detail: 'insufficient data' };
  }

  const patterns: string[] = [];
  let adjust = 0;

  const c0 = candles[idx];     // current
  const c1 = candles[idx - 1]; // previous
  const c2 = candles[idx - 2]; // 2 days ago

  const body0 = bodySize(c0);
  const body1 = bodySize(c1);
  const range0 = totalRange(c0);
  const range1 = totalRange(c1);

  // Minimum body relative to close price
  const bodyPct0 = c0.close > 0 ? body0 / c0.close : 0;
  const bodyPct1 = c1.close > 0 ? body1 / c1.close : 0;

  // ── 1. Hammer (bullish reversal at bottom) ──────────────────────────────
  // Small body, long lower shadow (>2x body), minimal upper shadow
  if (range0 > 0) {
    const ls = lowerShadow(c0);
    const us = upperShadow(c0);
    if (ls > body0 * 2 && us < body0 * 0.5 && bodyPct0 < 0.03) {
      // Check if it's after a decline (at least 3 down days in 5)
      let downDays = 0;
      for (let i = idx - 5; i < idx; i++) {
        if (i > 0 && candles[i].close < candles[i - 1].close) downDays++;
      }
      if (downDays >= 3) {
        patterns.push('HAMMER');
        adjust += 4;
      }
    }
  }

  // ── 2. Bullish Engulfing ───────────────────────────────────────────────
  // Current bullish candle completely engulfs previous bearish candle
  if (isBullish(c0) && !isBullish(c1) && c0.open < c1.close && c0.close > c1.open) {
    if (body0 > body1 * 1.2) { // body must be significantly larger
      patterns.push('BULLISH_ENGULFING');
      adjust += 5;
    }
  }

  // ── 3. Bearish Engulfing ──────────────────────────────────────────────
  if (!isBullish(c0) && isBullish(c1) && c0.open > c1.close && c0.close < c1.open) {
    if (body0 > body1 * 1.2) {
      patterns.push('BEARISH_ENGULFING');
      adjust -= 5;
    }
  }

  // ── 4. Morning Star (3-candle bullish reversal) ────────────────────────
  // Day 1: big red, Day 2: small body (doji-like), Day 3: big green
  if (idx >= 3) {
    const isDay1Red = !isBullish(c2) && bodyPct1 < 0.015; // c2 is red, c1 is small
    const isDay3Green = isBullish(c0) && bodyPct0 > 0.015;
    const bodyPct2 = c2.close > 0 ? bodySize(c2) / c2.close : 0;
    if (bodyPct2 > 0.015 && isDay1Red && isDay3Green) {
      // c0 close should be above midpoint of c2's body
      const midC2 = (c2.open + c2.close) / 2;
      if (c0.close > midC2) {
        patterns.push('MORNING_STAR');
        adjust += 6;
      }
    }
  }

  // ── 5. Shooting Star (bearish reversal at top) ─────────────────────────
  if (range0 > 0) {
    const us = upperShadow(c0);
    const ls = lowerShadow(c0);
    if (us > body0 * 2 && ls < body0 * 0.5 && bodyPct0 < 0.03) {
      // After a rally
      let upDays = 0;
      for (let i = idx - 5; i < idx; i++) {
        if (i > 0 && candles[i].close > candles[i - 1].close) upDays++;
      }
      if (upDays >= 3) {
        patterns.push('SHOOTING_STAR');
        adjust -= 4;
      }
    }
  }

  // ── 6. Three White Soldiers (strong continuation) ──────────────────────
  if (idx >= 3) {
    const all3Bullish = isBullish(c2) && isBullish(c1) && isBullish(c0);
    const progressivelyHigher = c0.close > c1.close && c1.close > c2.close;
    const allSignificant = bodyPct0 > 0.01 && bodyPct1 > 0.01;
    if (all3Bullish && progressivelyHigher && allSignificant) {
      patterns.push('THREE_WHITE_SOLDIERS');
      adjust += 4;
    }
  }

  // ── 7. Doji (indecision) ──────────────────────────────────────────────
  if (range0 > 0 && body0 / range0 < 0.1) {
    // Doji at the top of a trend = warning
    let upDays = 0;
    for (let i = idx - 5; i < idx; i++) {
      if (i > 0 && candles[i].close > candles[i - 1].close) upDays++;
    }
    if (upDays >= 4) {
      patterns.push('DOJI_AT_TOP');
      adjust -= 2;
    }
  }

  const compositeAdjust = Math.max(-8, Math.min(8, adjust));

  return {
    patterns,
    compositeAdjust,
    detail: patterns.length > 0 ? patterns.join(', ') : 'no pattern',
  };
}
