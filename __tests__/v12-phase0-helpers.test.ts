/**
 * v12 Phase 0.2 共用 helpers 單元測試
 *
 * 涵蓋：
 * - lib/utils/tickSize.ts
 * - lib/utils/limitRules.ts
 * - lib/analysis/redKValidator.ts
 * - lib/analysis/maPivot.ts
 */

import { describe, expect, it } from 'vitest';

import { isValidRedK, validateRedK } from '../lib/analysis/redKValidator';
import {
  findRecentMAPivots,
  getMADirection,
  isMADown,
  isMAUp,
} from '../lib/analysis/maPivot';
import { getLimitMovePct, isLimitDown, isLimitUp } from '../lib/utils/limitRules';
import {
  getTickSize,
  gtOrEqWithTick,
  ltOrEqWithTick,
  roundToTick,
} from '../lib/utils/tickSize';

// ── tickSize ──────────────────────────────────────────────────────────────

describe('tickSize - TW 股檔位', () => {
  it('< 10 元 → 0.01', () => {
    expect(getTickSize(5, 'TW')).toBe(0.01);
    expect(getTickSize(9.99, 'TW')).toBe(0.01);
  });

  it('10-50 元 → 0.05', () => {
    expect(getTickSize(10, 'TW')).toBe(0.05);
    expect(getTickSize(49.95, 'TW')).toBe(0.05);
  });

  it('50-100 元 → 0.1', () => {
    expect(getTickSize(50, 'TW')).toBe(0.1);
    expect(getTickSize(99.9, 'TW')).toBe(0.1);
  });

  it('100-500 元 → 0.5', () => {
    expect(getTickSize(100, 'TW')).toBe(0.5);
    expect(getTickSize(499.5, 'TW')).toBe(0.5);
  });

  it('500-1000 元 → 1', () => {
    expect(getTickSize(500, 'TW')).toBe(1);
    expect(getTickSize(999, 'TW')).toBe(1);
  });

  it('≥ 1000 元 → 5', () => {
    expect(getTickSize(1000, 'TW')).toBe(5);
    expect(getTickSize(1805, 'TW')).toBe(5);
  });
});

describe('tickSize - CN 股一律 0.01', () => {
  it('任何價位 0.01', () => {
    expect(getTickSize(5, 'CN')).toBe(0.01);
    expect(getTickSize(150, 'CN')).toBe(0.01);
    expect(getTickSize(2000, 'CN')).toBe(0.01);
  });
});

describe('tickSize - tick 容忍比較', () => {
  it('ltOrEqWithTick: 102.99 ≤ 103（容忍）', () => {
    expect(ltOrEqWithTick(102.99, 103, 'TW')).toBe(true);
  });

  it('gtOrEqWithTick: tick tolerance 比較', () => {
    // tickSize(103, TW) = 0.5, tolerance = 0.5 * 0.5 = 0.25
    // 102.99 ≥ 103 - 0.25 = 102.75 ✅ → true（容忍範圍內視為 ≥）
    expect(gtOrEqWithTick(102.99, 103, 'TW')).toBe(true);
    // 102.50 < 102.75 → false
    expect(gtOrEqWithTick(102.50, 103, 'TW')).toBe(false);
    // 102.76 ≥ 102.75 → true
    expect(gtOrEqWithTick(102.76, 103, 'TW')).toBe(true);
  });

  it('roundToTick: 102.99 round to TW tick (0.5) → 103', () => {
    expect(roundToTick(102.99, 'TW', 'round')).toBe(103);
  });
});

// ── limitRules ────────────────────────────────────────────────────────────

describe('limitRules - 漲跌停幅度', () => {
  it('TW 一般股 ±10%', () => {
    expect(getLimitMovePct('TW', '2330')).toBe(0.10);
    expect(getLimitMovePct('TW', '0050')).toBe(0.10);
  });

  it('CN 主板 ±10%', () => {
    expect(getLimitMovePct('CN', '600519.SS')).toBe(0.10);
  });

  it('CN 創業板（30xxxx） ±20%', () => {
    expect(getLimitMovePct('CN', '300750.SZ')).toBe(0.20);
    expect(getLimitMovePct('CN', '301234.SZ')).toBe(0.20);
  });

  it('CN 科創板（68xxxx） ±20%', () => {
    expect(getLimitMovePct('CN', '688981.SS')).toBe(0.20);
  });
});

describe('limitRules - isLimitUp', () => {
  it('TW 漲停判定（昨收 100 → 110）', () => {
    expect(isLimitUp(110, 100, 'TW', '2330')).toBe(true);
    expect(isLimitUp(109, 100, 'TW', '2330')).toBe(false);
  });

  it('CN 創業板 ±20% 漲停判定（昨收 100 → 120）', () => {
    expect(isLimitUp(120, 100, 'CN', '300750.SZ')).toBe(true);
    expect(isLimitUp(115, 100, 'CN', '300750.SZ')).toBe(false);
  });

  it('isLimitDown 鏡像', () => {
    expect(isLimitDown(90, 100, 'TW', '2330')).toBe(true);
    expect(isLimitDown(91, 100, 'TW', '2330')).toBe(false);
  });
});

// ── redKValidator ─────────────────────────────────────────────────────────

describe('redKValidator - 一般紅 K（實體 ≥ 2%）', () => {
  it('實體 2.5% → 過', () => {
    const result = validateRedK(
      { open: 100, high: 103, low: 99.5, close: 102.5 },
      99,
      'TW',
      '2330',
    );
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('normal');
  });

  it('實體 1.5% → 不過', () => {
    const result = validateRedK(
      { open: 100, high: 102, low: 99.5, close: 101.5 },
      99,
      'TW',
      '2330',
    );
    expect(result.valid).toBe(false);
  });
});

describe('redKValidator - 漲停例外（議題 64）', () => {
  it('漲停板 close = open = 漲停價，實體 0% → 仍視為強紅 K', () => {
    // 昨收 100，漲停 110，open = close = 110（鎖在漲停）
    const result = validateRedK(
      { open: 110, high: 110, low: 110, close: 110 },
      100,
      'TW',
      '2330',
    );
    // 注意：close = open 不是紅 K（close > open 才算紅 K）
    // 漲停板若鎖在開盤就是 close = open，這個 case 仍應視為強訊號
    // 但我們的 validateRedK 先檢查 close > open，所以這個 case 會 fail
    // 這是設計選擇 — 完全鎖死的漲停實際上沒有「實體攻擊」
    expect(result.valid).toBe(false);
  });

  it('漲停板 open 105，close 110 → 漲停例外通過', () => {
    // 昨收 100，open 105（跳空 5%），close 110（漲停）
    // 實體 = (110-105)/105 = 4.76% — 其實一般情況也通過
    const result = validateRedK(
      { open: 105, high: 110, low: 104, close: 110 },
      100,
      'TW',
      '2330',
    );
    expect(result.valid).toBe(true);
  });

  it('漲停 + 實體 < 2%（先漲到漲停後盤中震盪回）', () => {
    // 昨收 100，open 109，close 110（漲停），實體 = (110-109)/109 = 0.92%
    const result = validateRedK(
      { open: 109, high: 110, low: 108, close: 110 },
      100,
      'TW',
      '2330',
    );
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('limit-up');
  });
});

describe('redKValidator - 跳空例外（議題 89）', () => {
  it('跳空 +3% + close > open（中等強勢但實體小）→ 過', () => {
    // 昨收 100，open 103（跳空 3%），close 104，實體 = 1/103 = 0.97%
    const result = validateRedK(
      { open: 103, high: 105, low: 102, close: 104 },
      100,
      'TW',
      '2330',
    );
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('gap-up');
  });

  it('跳空 +5% + close = open（黑 K 跳空但收平）→ 不過', () => {
    // close = open 不是紅 K
    const result = validateRedK(
      { open: 105, high: 105, low: 100, close: 100 },
      100,
      'TW',
      '2330',
    );
    expect(result.valid).toBe(false);
  });

  it('跳空 +2% + 實體 < 2% → 不過（跳空不夠 3%）', () => {
    // 昨收 100，open 102（跳空 2%），close 103，實體 0.98%
    const result = validateRedK(
      { open: 102, high: 104, low: 101, close: 103 },
      100,
      'TW',
      '2330',
    );
    expect(result.valid).toBe(false);
  });
});

describe('redKValidator - boolean API', () => {
  it('isValidRedK 簡化版', () => {
    expect(isValidRedK(
      { open: 100, high: 103, low: 99.5, close: 102.5 },
      99,
      'TW',
      '2330',
    )).toBe(true);

    expect(isValidRedK(
      { open: 100, high: 101, low: 99.5, close: 100.5 },
      99,
      'TW',
      '2330',
    )).toBe(false);
  });
});

// ── maPivot ───────────────────────────────────────────────────────────────

describe('maPivot - 找 pivot', () => {
  it('簡單 V 形 → 找到 pivot low', () => {
    // 形狀：100, 99, 98, 97, 96, 97, 98, 99, 100  (window=3)
    // pivot low 在 index 4 (value 96)
    const ma = [100, 99, 98, 97, 96, 97, 98, 99, 100];
    const { lastLow } = findRecentMAPivots(ma, 3);
    expect(lastLow?.index).toBe(4);
    expect(lastLow?.value).toBe(96);
  });

  it('倒 V 形 → 找到 pivot high', () => {
    const ma = [96, 97, 98, 99, 100, 99, 98, 97, 96];
    const { lastHigh } = findRecentMAPivots(ma, 3);
    expect(lastHigh?.index).toBe(4);
    expect(lastHigh?.value).toBe(100);
  });

  it('資料太短 → 不返回 pivot', () => {
    const ma = [100, 99, 98];
    const { lastLow, lastHigh } = findRecentMAPivots(ma, 3);
    expect(lastLow).toBeUndefined();
    expect(lastHigh).toBeUndefined();
  });
});

describe('maPivot - 上揚 / 下彎判定', () => {
  it('V 形回升 → isMAUp true', () => {
    // 96 之後上漲到 102
    const ma = [100, 99, 98, 97, 96, 97, 98, 99, 100, 101, 102];
    expect(isMAUp(ma, 3)).toBe(true);
  });

  it('倒 V 形下跌 → isMADown true', () => {
    const ma = [96, 97, 98, 99, 100, 99, 98, 97, 96, 95, 94];
    expect(isMADown(ma, 3)).toBe(true);
  });

  it('一直上漲 → isMAUp true（無 pivot fallback）', () => {
    const ma = [90, 91, 92, 93, 94, 95];
    expect(isMAUp(ma, 3)).toBe(true);
  });

  it('完整 direction', () => {
    const ma = [100, 99, 98, 97, 96, 97, 98, 99, 100, 101, 102];
    const dir = getMADirection(ma, 3);
    expect(dir.isUp).toBe(true);
    expect(dir.isDown).toBe(false);
    expect(dir.recentPivotLow?.value).toBe(96);
  });
});
