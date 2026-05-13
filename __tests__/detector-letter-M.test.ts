/**
 * 0513 ABCDE B3 — detectLetterM (字母 M：N 字突破上升軌道線) 真實 fixture unit test
 *
 * 書本依據：抓住飆股 p.338 真突破 ×3% + 上升軌道線（兩低點連線 + 中間最高 anchor）。
 *
 * 6788.TWO 4/17 為 scan-TW-long-M-2026-04-17 hit 第一名 —
 *   軌道值 418、真突破門檻 430.54（×3%）、紅K 10.65%、量×3.31。
 */

import { describe, it, expect } from '@jest/globals';
import { detectLetterM } from '../lib/analysis/v12LetterM';
import { computeIndicators } from '../lib/indicators';
import triggeredFixture from './fixtures/candles/6788TWO-M-channel-breakout-2026-04-17.json';

describe('detectLetterM — 真實 fixture', () => {
  it(`${triggeredFixture.symbol} @ ${triggeredFixture.triggerDate} → M 突破上升軌道線觸發`, () => {
    const candles = computeIndicators(triggeredFixture.candles);
    const lastIdx = candles.length - 1;
    expect(candles[lastIdx].date).toBe(triggeredFixture.triggerDate);

    const result = detectLetterM(candles, lastIdx, 'TW', triggeredFixture.symbol);
    expect(result.triggered).toBe(triggeredFixture.expected.triggered);
    expect(result.channelValue!).toBeGreaterThanOrEqual(triggeredFixture.expected.channelValueMin);
    expect(result.channelValue!).toBeLessThanOrEqual(triggeredFixture.expected.channelValueMax);
    expect(result.breakoutThreshold!).toBeGreaterThanOrEqual(triggeredFixture.expected.breakoutThresholdMin);
    expect(result.breakoutThreshold!).toBeLessThanOrEqual(triggeredFixture.expected.breakoutThresholdMax);
    // 兩 pivot low + channel anchor index 都有
    expect(result.supportLow1Index).toBeDefined();
    expect(result.supportLow2Index).toBeDefined();
    expect(result.channelAnchorIndex).toBeDefined();
  });
});
