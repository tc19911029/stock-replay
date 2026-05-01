/**
 * ETFTrackingEntry forward return 計算
 *
 * 邏輯與 lib/backtest/ForwardAnalyzer.ts 相同：
 *   - basePrice = priceAtAdd
 *   - forwardCandles = candles.date > addedDate 之後最多 45 曆天
 *   - dNReturn = (candles[N].close - basePrice) / basePrice * 100
 *   - maxGain  = max(所有 dNReturn)
 *   - maxDrawdown = min(所有 dNReturn)（負數）
 *   - windowClosed = trading days elapsed >= 20
 */
import type { Candle } from '@/types';
import type { ETFTrackingEntry } from './types';

const FORWARD_TRADING_DAYS = 20;

function pct(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

function nullableAt(forward: Candle[], n: number, base: number): number | null {
  return forward.length >= n ? pct(base, forward[n - 1].close) : null;
}

export function updateTrackingEntry(
  entry: ETFTrackingEntry,
  candles: Candle[],
): ETFTrackingEntry {
  if (entry.priceAtAdd <= 0 || candles.length === 0) {
    return { ...entry, lastUpdated: new Date().toISOString() };
  }

  const sorted = [...candles].sort((a, b) => a.date.localeCompare(b.date));
  const forward = sorted.filter((c) => c.date > entry.addedDate);

  if (forward.length === 0) {
    return { ...entry, lastUpdated: new Date().toISOString() };
  }

  const base = entry.priceAtAdd;
  const allReturns = forward.slice(0, FORWARD_TRADING_DAYS).map((c) => pct(base, c.close));

  const d1 = nullableAt(forward, 1, base);
  const d3 = nullableAt(forward, 3, base);
  const d5 = nullableAt(forward, 5, base);
  const d10 = nullableAt(forward, 10, base);
  const d20 = nullableAt(forward, 20, base);

  const maxGain = allReturns.length > 0 ? Math.max(...allReturns) : null;
  const maxDrawdown = allReturns.length > 0 ? Math.min(...allReturns) : null;

  const windowClosed = forward.length >= FORWARD_TRADING_DAYS;

  return {
    ...entry,
    d1Return: d1,
    d3Return: d3,
    d5Return: d5,
    d10Return: d10,
    d20Return: d20,
    maxGain,
    maxDrawdown,
    windowClosed,
    lastUpdated: new Date().toISOString(),
  };
}
