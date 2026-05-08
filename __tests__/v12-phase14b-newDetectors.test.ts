/**
 * v12 Phase 1.4B — 5 個新 detector 測試（M/N/O/P/Q）
 *
 * 純結構測試 + 邊界 case；複雜的整合行為留 30 天歷史回放驗證。
 */

import type { CandleWithIndicators } from '../types';

import { detectLetterM } from '../lib/analysis/v12LetterM';
import { detectLetterN } from '../lib/analysis/v12LetterN';
import { detectLetterO } from '../lib/analysis/v12LetterO';
import { detectLetterP } from '../lib/analysis/v12LetterP';
import { detectLetterQ, shouldExitLetterQ } from '../lib/analysis/v12LetterQ';

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

// ── P 高檔拉回 ───────────────────────────────────────────────────────────

describe('v12 Phase 1.4B — P 高檔拉回', () => {
  it('資料不足 → 不觸發', () => {
    const candles = genFlatCandles(15);
    const result = detectLetterP(candles, 14);
    expect(result.triggered).toBe(false);
  });

  it('結構完整測試（detail 始終是 string）', () => {
    const candles = genFlatCandles(30);
    const result = detectLetterP(candles, 29);
    expect(typeof result.detail).toBe('string');
    expect(typeof result.triggered).toBe('boolean');
  });
});

// ── M 突破軌道線 ─────────────────────────────────────────────────────────

describe('v12 Phase 1.4B — M 突破軌道線', () => {
  it('資料不足（< 30）→ 不觸發', () => {
    const candles = genFlatCandles(20);
    const result = detectLetterM(candles, 19);
    expect(result.triggered).toBe(false);
  });

  it('結構完整測試', () => {
    const candles = genFlatCandles(35);
    const result = detectLetterM(candles, 34);
    expect(typeof result.detail).toBe('string');
  });
});

// ── O 打底完成 ───────────────────────────────────────────────────────────

describe('v12 Phase 1.4B — O 打底完成', () => {
  it('資料不足 → 不觸發', () => {
    const candles = genFlatCandles(20);
    const result = detectLetterO(candles, 19);
    expect(result.triggered).toBe(false);
  });

  it('純平盤無 MA20 → 不觸發', () => {
    const candles = genFlatCandles(35);
    const result = detectLetterO(candles, 34);
    expect(result.triggered).toBe(false);
  });
});

// ── Q 三條均線戰法 ────────────────────────────────────────────────────────

describe('v12 Phase 1.4B — Q 三條均線戰法', () => {
  it('資料不足 → 不觸發', () => {
    const candles = genFlatCandles(20);
    const result = detectLetterQ(candles, 19);
    expect(result.triggered).toBe(false);
  });

  it('沒有 MA3/MA10/MA24 → 不觸發', () => {
    const candles = genFlatCandles(30);  // 沒填 ma3/ma10/ma24
    const result = detectLetterQ(candles, 29);
    expect(result.triggered).toBe(false);
  });

  it('shouldExitLetterQ 資料不足 → 不出場', () => {
    const candles = genFlatCandles(5);
    const result = shouldExitLetterQ(candles, 4);
    expect(result.shouldExit).toBe(false);
  });

  it('shouldExitLetterQ MA3+MA10 死叉 + 跌破 MA3 → 出場', () => {
    const candles: CandleWithIndicators[] = [
      {
        date: '2026-01-01',
        open: 100, high: 101, low: 99, close: 100, volume: 1000,
        ma3: 99, ma10: 100,  // MA3 < MA10 (死叉狀態)
      },
      {
        date: '2026-01-02',
        open: 100, high: 101, low: 99, close: 98, volume: 1000,
        ma3: 99, ma10: 100,  // 仍死叉
      },
    ];
    // prev MA3 = 99, MA10 = 100 → MA3 < MA10
    // 改成 prev MA3 ≥ MA10 + today MA3 < MA10 形成死叉
    candles[0].ma3 = 100.5;
    candles[0].ma10 = 100;  // prev MA3 > MA10
    candles[1].ma3 = 99;
    candles[1].ma10 = 100;  // today MA3 < MA10 = 死叉
    candles[1].close = 98;  // close < MA3 (99) ⚠️ 等等需要 close < ma3=99 → 98 < 99 ✅

    const result = shouldExitLetterQ(candles, 1);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain('死叉');
  });
});

// ── N 型態確認 ───────────────────────────────────────────────────────────

describe('v12 Phase 1.4B — N 型態確認', () => {
  it('資料不足 → 不觸發', () => {
    const candles = genFlatCandles(20);
    const result = detectLetterN(candles, 19);
    expect(result.triggered).toBe(false);
  });

  it('純平盤無型態 → 不觸發', () => {
    const candles = genFlatCandles(40);
    const result = detectLetterN(candles, 39);
    expect(result.triggered).toBe(false);
  });

  it('結構完整測試', () => {
    const candles = genFlatCandles(40);
    const result = detectLetterN(candles, 39);
    expect(typeof result.detail).toBe('string');
    expect(typeof result.triggered).toBe('boolean');
  });
});

// ── 字母系統一致性檢查 ─────────────────────────────────────────────────────

describe('v12 Phase 1.4B — 字母系統一致性', () => {
  it('5 個新 detector 簽名統一', () => {
    const candles = genFlatCandles(40);
    const idx = 39;

    expect(typeof detectLetterP(candles, idx)).toBe('object');
    expect(typeof detectLetterM(candles, idx)).toBe('object');
    expect(typeof detectLetterO(candles, idx)).toBe('object');
    expect(typeof detectLetterQ(candles, idx)).toBe('object');
    expect(typeof detectLetterN(candles, idx)).toBe('object');
  });
});
