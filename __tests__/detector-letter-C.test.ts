/**
 * 0513 ABCDE B3 — detectConsolidationBreakout (字母 C：盤整突破) 真實 fixture unit test
 *
 * 書本依據：寶典 p.37 ②「狹幅盤整 5-6 天 + 突破上頸線 + 量 + 紅K」+ Part 7 p.488 攻擊量。
 *
 * 2404.TW 4/17 為 scan-TW-long-C-2026-04-17 hit 第二名 —
 *   盤整低點≈926，突破上頸線 938 + 紅K 11.05% + 量×2.93。
 */

import { describe, it, expect } from '@jest/globals';
import { detectConsolidationBreakout } from '../lib/analysis/breakoutEntry';
import { computeIndicators } from '../lib/indicators';
import triggeredFixture from './fixtures/candles/2404-C-consolidation-breakout-2026-04-17.json';

describe('detectConsolidationBreakout (C) — 真實 fixture', () => {
  it(`${triggeredFixture.symbol} @ ${triggeredFixture.triggerDate} → 盤整突破觸發`, () => {
    const candles = computeIndicators(triggeredFixture.candles);
    const lastIdx = candles.length - 1;
    expect(candles[lastIdx].date).toBe(triggeredFixture.triggerDate);

    const result = detectConsolidationBreakout(candles, lastIdx);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.isBreakout).toBe(true);
    expect(result.subType).toBe('consolidation_breakout');
    expect(result.breakoutPrice).toBeCloseTo(triggeredFixture.expected.breakoutPrice, 0);
    expect(result.bodyPct).toBeGreaterThanOrEqual(triggeredFixture.expected.bodyPctMin);
    expect(result.volumeRatio).toBeGreaterThanOrEqual(triggeredFixture.expected.volumeRatioMin);
    expect(result.consolidationLow!).toBeGreaterThanOrEqual(triggeredFixture.expected.consolidationLowMin);
    expect(result.consolidationLow!).toBeLessThanOrEqual(triggeredFixture.expected.consolidationLowMax);
  });
});
