/**
 * 0513 ABCDE B3 — detectLetterO (字母 O：低檔打底完成) 真實 fixture unit test
 *
 * 書本依據：抓住飆股「大量盤整打底」+ 翻多 + 站 MA20/MA60。
 *
 * 3044.TW 5/13 為 scan-TW-long-O-2026-05-13 hit 第一名 —
 *   25 天打底 + 爆量 + 翻多 + 站 MA20 + MA60 可長多 + 紅K 8.85% + 突破 513.00。
 */

import { describe, it, expect } from '@jest/globals';
import { detectLetterO } from '../lib/analysis/v12LetterO';
import { computeIndicators } from '../lib/indicators';
import triggeredFixture from './fixtures/candles/3044-O-base-complete-2026-05-13.json';

describe('detectLetterO — 真實 fixture', () => {
  it(`${triggeredFixture.symbol} @ ${triggeredFixture.triggerDate} → O 打底完成觸發`, () => {
    const candles = computeIndicators(triggeredFixture.candles);
    const lastIdx = candles.length - 1;
    expect(candles[lastIdx].date).toBe(triggeredFixture.triggerDate);

    const result = detectLetterO(candles, lastIdx, 'TW', triggeredFixture.symbol);
    expect(result.triggered).toBe(triggeredFixture.expected.triggered);
    expect(result.bodyPct!).toBeGreaterThanOrEqual(triggeredFixture.expected.bodyPctMin);
    expect(result.triggerPrice!).toBeGreaterThanOrEqual(triggeredFixture.expected.triggerPriceMin);
    expect(result.triggerPrice!).toBeLessThanOrEqual(triggeredFixture.expected.triggerPriceMax);
    expect(result.aboveMA60).toBe(triggeredFixture.expected.aboveMA60);
  });
});
