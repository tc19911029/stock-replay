/**
 * 0513 ABCDE B3 — detectBreakoutEntry (字母 B：回後買上漲) 真實 fixture unit test
 *
 * 用真實 K 線 + production indicator 計算驗 B 字母 detector 對歷史日期回的
 * 結構（前低、突破價、量比、實體 %）跟 production scan 紀錄一致。
 *
 * 6412.TW 5/11 為 scan-TW-long-B-2026-05-11 hit 候選 — 多頭回檔不破前低 85.2，
 * 5/11 站回 MA5 + 紅K 7.59% + 量×3.22 + 突破前 K 高 89.0。
 */

import { describe, it, expect } from '@jest/globals';
import { detectBreakoutEntry } from '../lib/analysis/breakoutEntry';
import { computeIndicators } from '../lib/indicators';
import triggeredFixture from './fixtures/candles/6412-B-pullback-buy-2026-05-11.json';

describe('detectBreakoutEntry (B) — 真實 fixture', () => {
  it(`${triggeredFixture.symbol} @ ${triggeredFixture.triggerDate} → 回後買上漲觸發`, () => {
    const candles = computeIndicators(triggeredFixture.candles);
    const lastIdx = candles.length - 1;
    expect(candles[lastIdx].date).toBe(triggeredFixture.triggerDate);

    const result = detectBreakoutEntry(candles, lastIdx);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.isBreakout).toBe(true);
    expect(result.subType).toBe('pullback_buy');
    expect(result.breakoutPrice).toBeCloseTo(triggeredFixture.expected.breakoutPrice, 1);
    expect(result.prevSwingLow).toBeCloseTo(triggeredFixture.expected.prevSwingLow, 1);
    expect(result.bodyPct).toBeGreaterThanOrEqual(triggeredFixture.expected.bodyPctMin);
    expect(result.volumeRatio).toBeGreaterThanOrEqual(triggeredFixture.expected.volumeRatioMin);
  });
});
