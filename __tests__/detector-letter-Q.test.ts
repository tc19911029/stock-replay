/**
 * 0513 ABCDE B3 — detectLetterQ (字母 Q：三條均線戰法) 真實 fixture unit test
 *
 * 書本依據：《抓住線圖》Part 4 第 8 章 p.261-265。
 * 戰法軌 Q 觸發即進場，不過 Step 1 但仍過 Step 0。
 *
 * 2241.TW 5/12 為 scan-TW-long-Q-2026-05-12 hit 第一名 —
 *   MA3=31.68 金叉 MA10=30.80 + 站上 MA3 + MA24=29.98 上揚 + 紅K 6.70%。
 */

import { describe, it, expect } from '@jest/globals';
import { detectLetterQ } from '../lib/analysis/v12LetterQ';
import { computeIndicators } from '../lib/indicators';
import triggeredFixture from './fixtures/candles/2241-Q-three-ma-2026-05-12.json';

describe('detectLetterQ — 真實 fixture', () => {
  it(`${triggeredFixture.symbol} @ ${triggeredFixture.triggerDate} → Q 三條均線戰法觸發`, () => {
    const candles = computeIndicators(triggeredFixture.candles);
    const lastIdx = candles.length - 1;
    expect(candles[lastIdx].date).toBe(triggeredFixture.triggerDate);

    const result = detectLetterQ(candles, lastIdx, 'TW', triggeredFixture.symbol);
    expect(result.triggered).toBe(triggeredFixture.expected.triggered);
    expect(result.goldenCrossToday).toBe(true);
    expect(result.aboveMA3).toBe(true);
    expect(result.ma24Up).toBe(true);
    expect(result.bodyPct).toBeGreaterThanOrEqual(triggeredFixture.expected.bodyPctMin);
    expect(result.ma3).toBeGreaterThanOrEqual(triggeredFixture.expected.ma3Min);
    expect(result.ma10).toBeGreaterThanOrEqual(triggeredFixture.expected.ma10Min);
    expect(result.ma24).toBeGreaterThanOrEqual(triggeredFixture.expected.ma24Min);
    // 停損守 MA10（書本 p.262）
    expect(result.stopLossMA).toBeCloseTo(result.ma10!, 1);
  });
});
