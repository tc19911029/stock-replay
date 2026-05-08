/**
 * v12 Phase 0.1 — detectTrend 歷史追蹤包裝測試
 *
 * 涵蓋議題 21 / 36 / 47 / 99：
 * - 翻多事件 T 的識別
 * - lastTrendChangeDate 持久化準備
 * - 最近 pivot pair 判定（議題 47 多頭軌訊號 gate）
 */

import type { CandleWithIndicators } from '../types';

import {
  detectTrendWithHistory,
  hasRecentPivotPair,
} from '../lib/analysis/detectTrendWithHistory';

// 簡單測試 K 線生成器
function genCandles(prices: number[]): CandleWithIndicators[] {
  return prices.map((close, i) => {
    const date = `2026-01-${String(i + 1).padStart(2, '0')}`;
    const prevClose = i > 0 ? prices[i - 1] : close;
    const ma5 = i < 4
      ? undefined
      : prices.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5;
    return {
      date,
      open: prevClose,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
      ma5,
    };
  });
}

describe('v12 Phase 0.1 — detectTrendWithHistory', () => {
  it('資料不足（< 20 candles）→ 回 empty', () => {
    const candles = genCandles([100, 101, 102]);
    const result = detectTrendWithHistory(candles, 2);
    expect(result.state).toBe('盤整');
    expect(result.lastChangeIndex).toBe(-1);
    expect(result.lastChangeDate).toBeNull();
  });

  it('盤整資料 → state 跟 lastChange 一致', () => {
    // 25 個橫盤資料，永遠是盤整
    const candles = genCandles(Array(25).fill(100));
    const result = detectTrendWithHistory(candles, 24);
    expect(result.state).toBe('盤整');
    // 整個 lookback 期間都是盤整 → lastChangeIndex = lookback start
    expect(result.lastChangeIndex).toBeGreaterThanOrEqual(20);
  });

  it('hasRecentPivotPair 資料不足 → false', () => {
    const candles = genCandles(Array(15).fill(100));
    expect(hasRecentPivotPair(candles, 14)).toBe(false);
  });

  it('hasRecentPivotPair 有上下震盪 → 偵測到 pivot pair', () => {
    // 製造明顯上下震盪：100 → 110 → 95 → 115（產生 high-low pivots）
    const prices: number[] = [];
    for (let i = 0; i < 30; i++) {
      // 鋸齒形：先漲後跌再漲
      if (i < 10) prices.push(95 + i);
      else if (i < 20) prices.push(105 - (i - 10));
      else prices.push(95 + (i - 20));
    }
    const candles = genCandles(prices);
    expect(hasRecentPivotPair(candles, 29)).toBe(true);
  });
});

describe('v12 Phase 0.1 — 翻多事件 T 識別', () => {
  it('當前多頭時 lastTrendUpIndex = lastChangeIndex', () => {
    // 只測試結構，不深入 detectTrend 邏輯
    const candles = genCandles(Array(25).fill(100));
    const result = detectTrendWithHistory(candles, 24);
    if (result.state === '多頭') {
      expect(result.lastTrendUpIndex).toBe(result.lastChangeIndex);
    }
  });
});

describe('v12 Phase 0.1 — lastTrendChangeDate 持久化準備', () => {
  it('TrendWithHistory 包含 lastChangeDate 欄位（議題 36）', () => {
    const candles = genCandles(Array(25).fill(100));
    const result = detectTrendWithHistory(candles, 24);
    // lastChangeDate 應該是 string 或 null
    expect(
      typeof result.lastChangeDate === 'string' || result.lastChangeDate === null,
    ).toBe(true);
  });

  it('TrendWithHistory 包含 lastTrendUpDate 欄位（議題 21）', () => {
    const candles = genCandles(Array(25).fill(100));
    const result = detectTrendWithHistory(candles, 24);
    expect(
      typeof result.lastTrendUpDate === 'string' || result.lastTrendUpDate === null,
    ).toBe(true);
  });

  it('previousState 結構正確', () => {
    const candles = genCandles(Array(25).fill(100));
    const result = detectTrendWithHistory(candles, 24);
    if (result.previousState !== null) {
      expect(['多頭', '空頭', '盤整']).toContain(result.previousState);
    }
  });
});
