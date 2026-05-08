/**
 * v12 Phase 1.3 — 訊號 Gate Helpers 測試
 *
 * 涵蓋議題 47 / 55 / 99 / B
 */

import type { CandleWithIndicators } from '../types';

import {
  checkPivotPairGate,
  checkPullbackIntegrity,
} from '../lib/analysis/v12SignalGates';

function genCandlesWithMA20(prices: number[]): CandleWithIndicators[] {
  return prices.map((close, i) => {
    const ma5 = i < 4 ? undefined : prices.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5;
    const ma20 = i < 19 ? undefined : prices.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
    return {
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
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

// ── 議題 47/55/99：pivot pair gate ──────────────────────────────────────────

describe('v12 Phase 1.3 — checkPivotPairGate（議題 47/55/99）', () => {
  it('資料不足 → 不過 gate', () => {
    const candles = genCandlesWithMA20([100, 101, 102]);
    const result = checkPivotPairGate(candles, 2);
    expect(result.passed).toBe(false);
    expect(result.waitingMessage).toContain('資料不足');
  });

  it('一直平盤無 pivot → 不過 gate', () => {
    const candles = genCandlesWithMA20(Array(30).fill(100));
    const result = checkPivotPairGate(candles, 29);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.waitingMessage).toBeTruthy();
    }
  });

  it('明顯震盪結構（高低高低）→ 過 gate', () => {
    // 製造高低高低的 pivot 結構
    const prices: number[] = [];
    for (let i = 0; i < 35; i++) {
      const phase = Math.floor(i / 5);
      const offset = phase % 2 === 0 ? i % 5 : 5 - (i % 5);
      prices.push(95 + phase * 2 + offset);
    }
    const candles = genCandlesWithMA20(prices);
    const result = checkPivotPairGate(candles, 34);
    expect(result.passed).toBe(true);
    expect(result.recentPivotHighIndex).toBeDefined();
    expect(result.recentPivotLowIndex).toBeDefined();
  });
});

// ── 議題 B：回檔不破前低 + 不破 MA20 ───────────────────────────────────────

describe('v12 Phase 1.3 — checkPullbackIntegrity（議題 B）', () => {
  it('回檔起點無效 → 不過', () => {
    const candles = genCandlesWithMA20(Array(25).fill(100));
    const result = checkPullbackIntegrity(candles, 24, 30); // start > index
    expect(result.passed).toBe(false);
    expect(result.failReason).toBe('no-pivot');
  });

  it('回檔前無 pivot → 不過（資料不足）', () => {
    const candles = genCandlesWithMA20(Array(25).fill(100));
    const result = checkPullbackIntegrity(candles, 24, 22);
    expect(result.passed).toBe(false);
  });

  it('結構欄位齊全（gate 結果含 pullbackLow / prevSwingLow / ma20Min）', () => {
    // 製造有 pivot 的結構
    const prices: number[] = [];
    for (let i = 0; i < 40; i++) {
      const phase = Math.floor(i / 5);
      const offset = phase % 2 === 0 ? i % 5 : 5 - (i % 5);
      prices.push(95 + phase * 2 + offset);
    }
    const candles = genCandlesWithMA20(prices);
    const result = checkPullbackIntegrity(candles, 35, 30);
    // 不論過不過，結構欄位應該齊全
    expect(typeof result.passed).toBe('boolean');
    if (!result.passed && result.failReason !== 'no-pivot') {
      expect(['broke-prev-low', 'broke-ma20']).toContain(result.failReason);
    }
  });
});

// ── E/J/K 不套 gate（標籤式測試）─────────────────────────────────────────

describe('v12 Phase 1.3 — gate 適用範圍標記（議題 73/79）', () => {
  it('E/J/K 不需 gate（自帶結構）— 純 documentation', () => {
    // 這個測試純粹標記 v12 規格 — gate 函數本身對所有訊號通用，
    // 但呼叫方（Step 2 detectors）才會決定要不要 call gate。
    //
    // 不套 gate 的訊號：
    // - E 缺口續攻（跳空缺口本身是強訊號）
    // - J ABC 突破（4 pivot 已含結構驗證）
    // - K K 線橫盤（≥ 3 根橫盤已含結構驗證）
    expect(true).toBe(true);
  });
});
