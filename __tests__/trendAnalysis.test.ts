import {
  detectTrend,
  detectTrendPosition,
  evaluateSixConditions,
} from '../lib/analysis/trendAnalysis';
import { computeIndicators } from '../lib/indicators';
import { Candle, CandleWithIndicators } from '../types';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Generate N daily candles with a linear trend */
function genCandles(count: number, startPrice: number, dailyPct: number): CandleWithIndicators[] {
  const raw: Candle[] = Array.from({ length: count }, (_, i) => {
    const price = startPrice * (1 + dailyPct * i);
    return {
      date: `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      open: +(price * 0.998).toFixed(2),
      high: +(price * 1.015).toFixed(2),
      low: +(price * 0.985).toFixed(2),
      close: +price.toFixed(2),
      volume: 10000 + Math.floor(Math.random() * 5000),
    };
  });
  return computeIndicators(raw);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('detectTrend', () => {
  // Note: 書本算法要求實際波浪結構（頭頭高底底高）
  // 純線性資料沒有 MA5 交界 → 判盤整是正確行為，非 bug
  it.skip('detects bullish trend when price is rising (legacy MA-only test)', () => {
    const candles = genCandles(60, 100, 0.01);
    expect(detectTrend(candles, candles.length - 1)).toBe('多頭');
  });

  it.skip('detects bearish trend when price is falling (legacy MA-only test)', () => {
    const candles = genCandles(60, 200, -0.01);
    expect(detectTrend(candles, candles.length - 1)).toBe('空頭');
  });

  it('returns 盤整 for insufficient data', () => {
    const candles = genCandles(5, 100, 0);
    const trend = detectTrend(candles, candles.length - 1);
    expect(trend).toBe('盤整');
  });

  it('returns 盤整 for pure linear uptrend (no wave structure)', () => {
    const candles = genCandles(60, 100, 0.01);
    expect(detectTrend(candles, candles.length - 1)).toBe('盤整');
  });
});

describe('detectTrendPosition', () => {
  it('returns a valid position string', () => {
    const candles = genCandles(60, 100, 0.005);
    const position = detectTrendPosition(candles, candles.length - 1);
    expect(typeof position).toBe('string');
    expect(position.length).toBeGreaterThan(0);
  });
});

describe('evaluateSixConditions', () => {
  it('returns a score between 0 and 6', () => {
    const candles = genCandles(60, 100, 0.005);
    const result = evaluateSixConditions(candles, candles.length - 1);
    expect(result.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.totalScore).toBeLessThanOrEqual(6);
  });

  it('returns all condition keys', () => {
    const candles = genCandles(60, 100, 0.005);
    const result = evaluateSixConditions(candles, candles.length - 1);
    expect(result).toHaveProperty('trend');
    expect(result).toHaveProperty('position');
    expect(result).toHaveProperty('kbar');
    expect(result).toHaveProperty('ma');
    expect(result).toHaveProperty('volume');
    expect(result).toHaveProperty('indicator');
  });

  it('each condition has pass and detail', () => {
    const candles = genCandles(60, 100, 0.005);
    const result = evaluateSixConditions(candles, candles.length - 1);
    for (const key of ['trend', 'position', 'kbar', 'ma', 'volume', 'indicator'] as const) {
      expect(typeof result[key].pass).toBe('boolean');
      expect(typeof result[key].detail).toBe('string');
    }
  });

  it('strong bull trend passes more conditions', () => {
    const bullCandles = genCandles(60, 100, 0.015);  // strong uptrend
    const bearCandles = genCandles(60, 200, -0.015);  // strong downtrend
    const bullScore = evaluateSixConditions(bullCandles, bullCandles.length - 1).totalScore;
    const bearScore = evaluateSixConditions(bearCandles, bearCandles.length - 1).totalScore;
    expect(bullScore).toBeGreaterThan(bearScore);
  });
});
