/**
 * 0513 ABCDE B3 — detectStrategyE (字母 D：一字底型態突破) 真實 fixture unit test
 *
 * 注意命名歷史包袱：detectStrategyE 對應 scan letter D（04-21 命名重整未對齊 letter id）。
 *
 * 書本依據：抓住飆股 25 型態 #9「長期盤整」+ 朱家泓「均線糾結突破=爆量」三要素。
 *
 * 5215.TW 5/13 為 scan-TW-long-D-2026-05-13 hit 第一名 —
 *   盤整 105 天 + 均線糾結 + 量縮 → 大量突破，頸線 34.5~42.1。
 */

import { describe, it, expect } from '@jest/globals';
import { detectStrategyE } from '../lib/analysis/highWinRateEntry';
import { computeIndicators } from '../lib/indicators';
import triggeredFixture from './fixtures/candles/5215-D-flat-bottom-2026-05-13.json';

describe('detectStrategyE (D：一字底突破) — 真實 fixture', () => {
  it(`${triggeredFixture.symbol} @ ${triggeredFixture.triggerDate} → 一字底型態突破`, () => {
    const candles = computeIndicators(triggeredFixture.candles);
    const lastIdx = candles.length - 1;
    expect(candles[lastIdx].date).toBe(triggeredFixture.triggerDate);

    const result = detectStrategyE(candles, lastIdx);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.isFlatBottom).toBe(true);
    expect(result.consolidationDays).toBeGreaterThanOrEqual(triggeredFixture.expected.consolidationDaysMin);
  });
});
