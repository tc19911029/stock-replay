/**
 * 0513 ABCDE B3 — detectVReversal (字母 F) 真實 fixture unit test
 *
 * 用真實 K 線 + production indicator 計算驗 V 反轉 detector 對 lockwatch 紀錄日期回的
 * 結構（變盤線位置/型態、跌幅、量比、突破前 K 高）跟 lockwatch 觸發紀錄一致。
 *
 * 6907.TWO 4/23 為 lockwatch F 觸發第一日 — vBottom 110.5 / triggerPrice 140。
 */

import { describe, it, expect } from '@jest/globals';
import { detectVReversal } from '../lib/analysis/vReversalDetector';
import { computeIndicators } from '../lib/indicators';
import triggeredFixture from './fixtures/candles/6907TWO-F-v-reversal-2026-04-23.json';

describe('detectVReversal — 真實 fixture', () => {
  it(`${triggeredFixture.symbol} @ ${triggeredFixture.triggerDate} → V 反轉成立`, () => {
    const candles = computeIndicators(triggeredFixture.candles);
    const lastIdx = candles.length - 1;
    expect(candles[lastIdx].date).toBe(triggeredFixture.triggerDate);

    const result = detectVReversal(candles, lastIdx);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.isVReversal).toBe(true);
    expect(result.stopBarLow).toBeCloseTo(triggeredFixture.expected.stopBarLow, 1);
    expect(result.stopBarShape).toBe(triggeredFixture.expected.stopBarShape);
    expect(result.precedingDrop).toBeGreaterThanOrEqual(triggeredFixture.expected.precedingDropMin);
    expect(result.prevHigh).toBeCloseTo(triggeredFixture.expected.prevHigh, 1);
  });
});
