/**
 * 0513 ABCDE B3 — detectLetterP (字母 P：高檔拉回) 真實 fixture unit test
 *
 * 書本依據：寶典「等拉回」≤ 2 天淺回 + 拉回前明顯上漲 ≥ 5% + 突破前 K 高。
 *
 * 2474.TW 4/17 為 scan-TW-long-P-2026-04-17 hit 第二名 —
 *   多頭 + 1 天淺回不破 MA20 + 紅K 6.63% + 量×3.86 + 突破前 K 高 201.5。
 */

import { describe, it, expect } from '@jest/globals';
import { detectLetterP } from '../lib/analysis/v12LetterP';
import { computeIndicators } from '../lib/indicators';
import triggeredFixture from './fixtures/candles/2474-P-pullback-2026-04-17.json';

describe('detectLetterP — 真實 fixture', () => {
  it(`${triggeredFixture.symbol} @ ${triggeredFixture.triggerDate} → P 高檔拉回觸發`, () => {
    const candles = computeIndicators(triggeredFixture.candles);
    const lastIdx = candles.length - 1;
    expect(candles[lastIdx].date).toBe(triggeredFixture.triggerDate);

    const result = detectLetterP(candles, lastIdx, 'TW', triggeredFixture.symbol);
    expect(result.triggered).toBe(triggeredFixture.expected.triggered);
    expect(result.bodyPct!).toBeGreaterThanOrEqual(triggeredFixture.expected.bodyPctMin);
    expect(result.volumeRatio!).toBeGreaterThanOrEqual(triggeredFixture.expected.volumeRatioMin);
    expect(result.triggerPrice!).toBeGreaterThanOrEqual(triggeredFixture.expected.triggerPriceMin);
    expect(result.triggerPrice!).toBeLessThanOrEqual(triggeredFixture.expected.triggerPriceMax);
    expect(result.pullbackDays!).toBeLessThanOrEqual(triggeredFixture.expected.pullbackDaysMax);
  });
});
