/**
 * v12 Phase 1.1 — Step 0 大盤過濾測試
 *
 * 涵蓋議題 53 / 63 / 66 / 68 / 97 / 99
 */

import type { CandleWithIndicators } from '../types';

import {
  MARKET_INDEX_SYMBOL,
  evaluateMarketGate,
} from '../lib/scanner/marketTrendGate';

function genIndexCandles(opts: {
  count: number;
  pattern: 'rising' | 'falling' | 'flat' | 'rising-with-pivots';
  startPrice?: number;
}): CandleWithIndicators[] {
  const { count, pattern, startPrice = 100 } = opts;
  const prices: number[] = [];

  for (let i = 0; i < count; i++) {
    if (pattern === 'rising') prices.push(startPrice + i);
    else if (pattern === 'falling') prices.push(startPrice - i);
    else if (pattern === 'flat') prices.push(startPrice);
    else {
      // rising-with-pivots: 製造高低高低高 結構
      const phase = Math.floor(i / 5);
      const offset = phase % 2 === 0 ? i % 5 : 5 - (i % 5);
      prices.push(startPrice + phase * 2 + offset);
    }
  }

  return prices.map((close, i) => {
    const date = `2026-01-${String(i + 1).padStart(2, '0')}`;
    const ma5 = i < 4 ? undefined : prices.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5;
    const ma20 = i < 19 ? undefined : prices.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
    return {
      date,
      open: i > 0 ? prices[i - 1] : close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
      ma5,
      ma20,
    };
  });
}

describe('v12 Phase 1.1 — 大盤指數常數（議題 68）', () => {
  it('TW = ^TWII', () => {
    expect(MARKET_INDEX_SYMBOL.TW).toBe('^TWII');
  });

  it('CN = 000001.SS', () => {
    expect(MARKET_INDEX_SYMBOL.CN).toBe('000001.SS');
  });
});

describe('v12 Phase 1.1 — Step 0.1 大盤過濾', () => {
  it('資料不足（< 20 candles）→ data-insufficient', () => {
    const candles = genIndexCandles({ count: 15, pattern: 'rising' });
    const result = evaluateMarketGate(candles);
    expect(result.passed).toBe(false);
    expect(result.blockReason).toBe('data-insufficient');
  });

  it('完全平盤 → trend not bullish', () => {
    const candles = genIndexCandles({ count: 30, pattern: 'flat' });
    const result = evaluateMarketGate(candles);
    expect(result.passed).toBe(false);
    expect(result.blockReason).toBe('trend-not-bullish');
    expect(result.bannerText).toContain('盤整');
  });

  it('一直下跌 → trend not bullish', () => {
    const candles = genIndexCandles({ count: 30, pattern: 'falling' });
    const result = evaluateMarketGate(candles);
    expect(result.passed).toBe(false);
    expect(result.blockReason).toBe('trend-not-bullish');
  });

  it('結果含 trendState 欄位（議題 69 banner 用）', () => {
    const candles = genIndexCandles({ count: 30, pattern: 'flat' });
    const result = evaluateMarketGate(candles);
    expect(['多頭', '空頭', '盤整']).toContain(result.trendState);
    expect(typeof result.bannerText).toBe('string');
  });

  it('結果含 isAboveMA20 / isMA20Up / hasPivotPair 欄位', () => {
    const candles = genIndexCandles({ count: 30, pattern: 'rising' });
    const result = evaluateMarketGate(candles);
    expect(typeof result.isAboveMA20).toBe('boolean');
    expect(typeof result.isMA20Up).toBe('boolean');
    expect(typeof result.hasPivotPair).toBe('boolean');
  });
});

describe('v12 Phase 1.1 — Step 0.1 失敗 banner 文案', () => {
  it('資料不足 banner', () => {
    const candles = genIndexCandles({ count: 15, pattern: 'rising' });
    const result = evaluateMarketGate(candles);
    expect(result.bannerText).toContain('資料不足');
  });

  it('盤整 banner', () => {
    const candles = genIndexCandles({ count: 30, pattern: 'flat' });
    const result = evaluateMarketGate(candles);
    expect(result.bannerText).toContain('盤整');
  });
});
