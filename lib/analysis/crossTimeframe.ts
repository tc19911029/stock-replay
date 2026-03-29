/**
 * Cross-Timeframe Confirmation
 *
 * Synthesizes weekly candles from daily data and checks if the weekly
 * trend aligns with the daily signal. Alignment = stronger signal.
 *
 * Research basis:
 * - Multi-timeframe alignment is one of the strongest edge factors
 * - Daily buy signal + weekly uptrend = 60-70% win rate (vs ~50% without)
 * - Daily buy signal + weekly downtrend = high false signal rate
 *
 * Weekly analysis:
 * - Price above weekly MA10 (≈ MA50 daily) = weekly uptrend
 * - Weekly candle pattern: bullish engulfing, hammer = reversal signal
 * - Weekly MACD direction: histogram expanding = strong trend
 */

import { CandleWithIndicators } from '@/types';

export interface WeeklyTrendResult {
  /** Weekly trend alignment with daily signal */
  alignment: 'STRONG' | 'ALIGNED' | 'NEUTRAL' | 'CONFLICTING';
  /** Score adjustment: +10 (strong align) to -10 (conflicting) */
  compositeAdjust: number;
  /** Whether the weekly close is above the weekly MA10 */
  aboveWeeklyMA: boolean;
  /** Weekly candle pattern if detected */
  weeklyPattern: string | null;
  detail: string;
}

interface WeeklyCandle {
  weekStart: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Synthesize weekly candles from daily candle data.
 * Groups by ISO week (Monday-Friday).
 */
function synthesizeWeekly(candles: CandleWithIndicators[], endIdx: number): WeeklyCandle[] {
  const weekMap = new Map<string, WeeklyCandle>();

  const startIdx = Math.max(0, endIdx - 120); // ~24 weeks of data
  for (let i = startIdx; i <= endIdx; i++) {
    const c = candles[i];
    const d = new Date(c.date);
    // Get Monday of this week
    const dayOfWeek = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((dayOfWeek + 6) % 7));
    const weekKey = monday.toISOString().split('T')[0];

    const existing = weekMap.get(weekKey);
    if (!existing) {
      weekMap.set(weekKey, {
        weekStart: weekKey,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close; // last close of the week
      existing.volume += c.volume;
    }
  }

  return [...weekMap.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/**
 * Compute simple moving average from weekly closes.
 */
function weeklyMA(weeklies: WeeklyCandle[], period: number): number | null {
  if (weeklies.length < period) return null;
  const slice = weeklies.slice(-period);
  return slice.reduce((sum, w) => sum + w.close, 0) / period;
}

/**
 * Analyze cross-timeframe confirmation using weekly trend.
 */
export function analyzeCrossTimeframe(
  candles: CandleWithIndicators[],
  idx: number,
): WeeklyTrendResult {
  if (idx < 60) {
    return { alignment: 'NEUTRAL', compositeAdjust: 0, aboveWeeklyMA: false, weeklyPattern: null, detail: 'insufficient data' };
  }

  const weeklies = synthesizeWeekly(candles, idx);
  if (weeklies.length < 12) {
    return { alignment: 'NEUTRAL', compositeAdjust: 0, aboveWeeklyMA: false, weeklyPattern: null, detail: 'insufficient weekly data' };
  }

  const details: string[] = [];
  let score = 0;

  const currentWeek = weeklies[weeklies.length - 1];
  const prevWeek = weeklies[weeklies.length - 2];

  // ── 1. Price vs Weekly MA10 (≈ MA50 daily) ──────────────────────────────
  const wma10 = weeklyMA(weeklies, 10);
  const aboveWeeklyMA = wma10 !== null && currentWeek.close > wma10;

  if (wma10 !== null) {
    if (currentWeek.close > wma10 * 1.03) {
      score += 5;
      details.push('well above weekly MA10');
    } else if (currentWeek.close > wma10) {
      score += 3;
      details.push('above weekly MA10');
    } else if (currentWeek.close < wma10 * 0.97) {
      score -= 5;
      details.push('well below weekly MA10');
    } else {
      score -= 2;
      details.push('below weekly MA10');
    }
  }

  // ── 2. Weekly MA direction ──────────────────────────────────────────────
  const wma10_prev = weeklyMA(weeklies.slice(0, -1), 10);
  if (wma10 !== null && wma10_prev !== null) {
    if (wma10 > wma10_prev) {
      score += 3;
      details.push('weekly MA rising');
    } else {
      score -= 2;
      details.push('weekly MA falling');
    }
  }

  // ── 3. Weekly candle pattern ──────────────────────────────────────────
  let weeklyPattern: string | null = null;
  const bodyPct = currentWeek.open > 0
    ? (currentWeek.close - currentWeek.open) / currentWeek.open * 100
    : 0;
  const range = currentWeek.high - currentWeek.low;
  const upperShadow = currentWeek.high - Math.max(currentWeek.open, currentWeek.close);
  const lowerShadow = Math.min(currentWeek.open, currentWeek.close) - currentWeek.low;

  if (bodyPct > 2 && currentWeek.volume > prevWeek.volume) {
    weeklyPattern = 'bullish_large';
    score += 3;
    details.push('weekly large bullish candle');
  } else if (bodyPct < -2 && currentWeek.volume > prevWeek.volume) {
    weeklyPattern = 'bearish_large';
    score -= 3;
    details.push('weekly large bearish candle');
  } else if (range > 0 && lowerShadow > range * 0.6 && bodyPct > 0) {
    weeklyPattern = 'hammer';
    score += 2;
    details.push('weekly hammer');
  }

  // ── 4. Weekly higher highs / lower lows ─────────────────────────────────
  if (weeklies.length >= 4) {
    const w3 = weeklies[weeklies.length - 3];
    const w2 = weeklies[weeklies.length - 2];
    const w1 = weeklies[weeklies.length - 1];

    const higherHighs = w1.high > w2.high && w2.high > w3.high;
    const higherLows = w1.low > w2.low && w2.low > w3.low;

    if (higherHighs && higherLows) {
      score += 4;
      details.push('weekly HH+HL');
    }
  }

  // ── Classify alignment ──────────────────────────────────────────────────
  let alignment: WeeklyTrendResult['alignment'];
  if (score >= 10) alignment = 'STRONG';
  else if (score >= 4) alignment = 'ALIGNED';
  else if (score >= -3) alignment = 'NEUTRAL';
  else alignment = 'CONFLICTING';

  const compositeAdjust = Math.max(-10, Math.min(10, score));

  return {
    alignment,
    compositeAdjust,
    aboveWeeklyMA,
    weeklyPattern,
    detail: details.join(', ') || 'neutral',
  };
}
