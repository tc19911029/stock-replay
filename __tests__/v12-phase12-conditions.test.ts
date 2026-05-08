/**
 * v12 Phase 1.2 — 純書本條件 helpers 測試
 *
 * 涵蓋議題 13 / 27 / 51 / 88 / 91 / 102
 */

import type { CandleWithIndicators } from '../types';

import {
  detectEndPhase,
  detectSeasonLineResistance,
  evaluateIndicatorV12,
  evaluateVolumeV12,
} from '../lib/analysis/v12Conditions';

function mkCandle(opts: Partial<CandleWithIndicators> & { close: number }): CandleWithIndicators {
  const { close, volume, ...rest } = opts;
  return {
    date: '2026-05-08',
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: volume ?? 1000,
    ...rest,
  };
}

// ── 議題 51：⑥ 指標純書本（拿掉 OSC）────────────────────────────────────────

describe('v12 Phase 1.2 — evaluateIndicatorV12（議題 51）', () => {
  it('KD 多排（K > D + K 上升）→ 過 ⑥', () => {
    const result = evaluateIndicatorV12(
      mkCandle({ close: 100, kdK: 60, kdD: 50 }),
      mkCandle({ close: 99, kdK: 55, kdD: 50 }),
    );
    expect(result.passed).toBe(true);
    expect(result.kdBullish).toBe(true);
  });

  it('MACD 多排（DIF > DEA + DIF 上升）→ 過 ⑥', () => {
    const result = evaluateIndicatorV12(
      mkCandle({ close: 100, macdDIF: 0.5, macdSignal: 0.3 }),
      mkCandle({ close: 99, macdDIF: 0.4, macdSignal: 0.3 }),
    );
    expect(result.passed).toBe(true);
    expect(result.macdBullish).toBe(true);
  });

  it('KD 死叉 + MACD 死叉 → 不過 ⑥', () => {
    const result = evaluateIndicatorV12(
      mkCandle({ close: 100, kdK: 40, kdD: 50, macdDIF: 0.2, macdSignal: 0.5 }),
      mkCandle({ close: 99, kdK: 50, kdD: 50, macdDIF: 0.3, macdSignal: 0.5 }),
    );
    expect(result.passed).toBe(false);
  });

  it('KD 向下 → 警示但不擋（議題 27）', () => {
    const result = evaluateIndicatorV12(
      mkCandle({ close: 100, kdK: 50, kdD: 40, macdDIF: 0.5, macdSignal: 0.3 }),
      mkCandle({ close: 99, kdK: 60, kdD: 40, macdDIF: 0.4, macdSignal: 0.3 }),
    );
    expect(result.kdDecliningWarning).toBe(true);
    // 雖然 KD 向下但 MACD 過 → 仍過 ⑥
    expect(result.passed).toBe(true);
  });

  it('純書本不用 OSC（議題 51）', () => {
    // OSC 變化但 DIF 不上升 → MACD 不過
    const result = evaluateIndicatorV12(
      mkCandle({ close: 100, macdDIF: 0.4, macdSignal: 0.3, macdOSC: 0.1 }),
      mkCandle({ close: 99, macdDIF: 0.5, macdSignal: 0.45, macdOSC: 0.05 }),
      // OSC 從 0.05 → 0.1 是上升，但 DIF 從 0.5 → 0.4 是下降
    );
    expect(result.macdBullish).toBe(false); // v12 看 DIF 不看 OSC
  });
});

// ── 議題 88：⑤ 量分等級 ───────────────────────────────────────────────────

describe('v12 Phase 1.2 — evaluateVolumeV12（議題 88）', () => {
  it('量比 1.5× → 一般攻擊量', () => {
    const result = evaluateVolumeV12(
      mkCandle({ close: 100, volume: 1500 }),
      mkCandle({ close: 99, volume: 1000 }),
    );
    expect(result.passed).toBe(true);
    expect(result.level).toBe('normal');
    expect(result.detail).toContain('一般攻擊量');
  });

  it('量比 2.5× → 爆量', () => {
    const result = evaluateVolumeV12(
      mkCandle({ close: 100, volume: 2500 }),
      mkCandle({ close: 99, volume: 1000 }),
    );
    expect(result.passed).toBe(true);
    expect(result.level).toBe('climax');
    expect(result.detail).toContain('爆量');
  });

  it('量比 1.2× → 不過', () => {
    const result = evaluateVolumeV12(
      mkCandle({ close: 100, volume: 1200 }),
      mkCandle({ close: 99, volume: 1000 }),
    );
    expect(result.passed).toBe(false);
    expect(result.level).toBeUndefined();
  });

  it('前日量為 0（停牌）→ 不過（純書本不防呆）', () => {
    const result = evaluateVolumeV12(
      mkCandle({ close: 100, volume: 1000 }),
      mkCandle({ close: 99, volume: 0 }),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('資料不足');
  });
});

// ── 議題 13：末升段 detector ──────────────────────────────────────────────

describe('v12 Phase 1.2 — detectEndPhase（議題 13）', () => {
  function genRisingCandles(prices: number[]): CandleWithIndicators[] {
    return prices.map((close, i) => {
      const ma5 = i < 4
        ? undefined
        : prices.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5;
      return {
        date: `2026-01-${String(i + 1).padStart(2, '0')}`,
        open: i > 0 ? prices[i - 1] : close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
        ma5,
      };
    });
  }

  it('資料不足 → 不在末升段', () => {
    const candles = genRisingCandles([100, 101, 102]);
    const result = detectEndPhase(candles, 2);
    expect(result.isEndPhase).toBe(false);
  });

  it('沒有確認 pivot → 不在末升段', () => {
    const candles = genRisingCandles(Array(25).fill(100));
    const result = detectEndPhase(candles, 24);
    // 平盤沒有 pivot
    expect(result.isEndPhase).toBe(false);
  });
});

// ── 議題 27：季線下彎警示 ─────────────────────────────────────────────────

describe('v12 Phase 1.2 — detectSeasonLineResistance（議題 27）', () => {
  it('資料不足（< 60 candles）→ 無警示', () => {
    const candles: CandleWithIndicators[] = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: 100, high: 101, low: 99, close: 100, volume: 1000,
    }));
    const result = detectSeasonLineResistance(candles, 29);
    expect(result.isAbove).toBe(false);
    expect(result.badge).toBe('');
  });

  it('股價在 MA60 之下 → isAbove=true（壓力存在）', () => {
    const candles: CandleWithIndicators[] = Array.from({ length: 70 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: 100, high: 101, low: 99, close: 95, volume: 1000,
      ma60: 105, // MA60 在股價上方
    }));
    const result = detectSeasonLineResistance(candles, 69);
    expect(result.isAbove).toBe(true);
    expect(result.ma60Value).toBe(105);
  });

  it('股價在 MA60 之上 → isAbove=false（無壓力）', () => {
    const candles: CandleWithIndicators[] = Array.from({ length: 70 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: 100, high: 101, low: 99, close: 110, volume: 1000,
      ma60: 105,
    }));
    const result = detectSeasonLineResistance(candles, 69);
    expect(result.isAbove).toBe(false);
    expect(result.badge).toBe('');
  });
});
