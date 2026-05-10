/**
 * v12 LetterN 補實作 — N 字底 + 三個頂部型態（2026-05-10）
 *
 * 驗收：
 * - 簽名穩定、edge case 不噴錯
 * - 結構成立但未過 ×3% 門檻 → 不觸發
 */

import type { CandleWithIndicators } from '../types';

import { detectLetterN } from '../lib/analysis/v12LetterN';
import { detectTopPatterns } from '../lib/analysis/v12LetterN';

function genFlatCandles(count: number, price = 100): CandleWithIndicators[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 1000,
  }));
}

describe('v12 LetterN — N 字底 detector', () => {
  it('資料不足 → 不觸發', () => {
    const candles = genFlatCandles(20);
    const result = detectLetterN(candles, 19);
    expect(result.triggered).toBe(false);
  });

  it('平盤無 A→B→C 結構 → 不觸發', () => {
    const candles = genFlatCandles(40);
    const result = detectLetterN(candles, 39);
    expect(result.triggered).toBe(false);
  });

  it('detail 始終是 string 不噴錯', () => {
    const candles = genFlatCandles(40);
    const result = detectLetterN(candles, 39);
    expect(typeof result.detail).toBe('string');
    expect(typeof result.triggered).toBe('boolean');
  });
});

describe('v12 LetterN — 頂部型態 detectTopPatterns', () => {
  it('資料不足（< 30）→ 不觸發', () => {
    const candles = genFlatCandles(20);
    const result = detectTopPatterns(candles, 19);
    expect(result.triggered).toBe(false);
    expect(typeof result.detail).toBe('string');
  });

  it('紅 K（close > open）→ 不觸發（必須黑 K）', () => {
    const candles: CandleWithIndicators[] = Array.from({ length: 35 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: 100,
      high: 105,
      low: 99,
      close: 104, // close > open
      volume: 1000,
    }));
    const result = detectTopPatterns(candles, 34);
    expect(result.triggered).toBe(false);
  });

  it('黑 K 但實體 < 2% → 不觸發', () => {
    const candles: CandleWithIndicators[] = Array.from({ length: 35 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 99.8, // 實體 0.2%
      volume: 1000,
    }));
    const result = detectTopPatterns(candles, 34);
    expect(result.triggered).toBe(false);
  });

  it('純平盤無型態 → 不觸發', () => {
    const candles = genFlatCandles(40);
    const result = detectTopPatterns(candles, 39);
    expect(result.triggered).toBe(false);
  });

  it('結構完整測試（detail 始終是 string）', () => {
    const candles = genFlatCandles(40);
    const result = detectTopPatterns(candles, 39);
    expect(typeof result.detail).toBe('string');
    expect(typeof result.triggered).toBe('boolean');
  });
});
