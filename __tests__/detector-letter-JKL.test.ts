/**
 * 0513 ABCDE B3 — 字母 J / K / L detector 真實 fixture unit tests
 *
 * J: detectABCBreakout — ABC 三段切線突破（書本「ABC 三段攻擊」）
 * K: detectKlineConsolidationBreakout — K 線盤整突破（anchor 黑K 後窄幅整理 → 突破）
 * L: detectBlackKBreakout — 黑K 後攻擊紅K 突破黑K高
 *
 * Ground truth：來自 production scan-TW-long-{J/K/L}-*.json 紀錄。
 */

import { describe, it, expect } from '@jest/globals';
import { detectABCBreakout } from '../lib/analysis/abcBreakoutEntry';
import { detectKlineConsolidationBreakout } from '../lib/analysis/klineConsolidationBreakout';
import { detectBlackKBreakout } from '../lib/analysis/blackKBreakoutEntry';
import { computeIndicators } from '../lib/indicators';
import jFix from './fixtures/candles/8147TWO-J-abc-breakout-2026-04-17.json';
import kFix from './fixtures/candles/3583-K-kline-consolidation-2026-05-11.json';
import lFix from './fixtures/candles/4927-L-blackK-breakout-2026-05-05.json';

describe('detectABCBreakout (J) — 真實 fixture', () => {
  it(`${jFix.symbol} @ ${jFix.triggerDate} → ABC 突破`, () => {
    const candles = computeIndicators(jFix.candles);
    const result = detectABCBreakout(candles, candles.length - 1);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.isABCBreakout).toBe(true);
    expect(result.bodyPct).toBeGreaterThanOrEqual(jFix.expected.bodyPctMin);
    expect(result.volumeRatio).toBeGreaterThanOrEqual(jFix.expected.volumeRatioMin);
    expect(result.legAHigh).toBeGreaterThanOrEqual(jFix.expected.legAHighMin);
    expect(result.legAHigh).toBeLessThanOrEqual(jFix.expected.legAHighMax);
  });
});

describe('detectKlineConsolidationBreakout (K) — 真實 fixture', () => {
  it(`${kFix.symbol} @ ${kFix.triggerDate} → K 線盤整突破`, () => {
    const candles = computeIndicators(kFix.candles);
    const result = detectKlineConsolidationBreakout(candles, candles.length - 1);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.isBreakout).toBe(true);
    expect(result.anchorHigh).toBeGreaterThanOrEqual(kFix.expected.anchorHighMin);
    expect(result.anchorHigh).toBeLessThanOrEqual(kFix.expected.anchorHighMax);
    expect(result.rangeWidthPct).toBeLessThanOrEqual(kFix.expected.rangeWidthPctMax);
    expect(result.consolidationDays).toBeGreaterThanOrEqual(kFix.expected.consolidationDaysMin);
  });
});

describe('detectBlackKBreakout (L) — 真實 fixture', () => {
  it(`${lFix.symbol} @ ${lFix.triggerDate} → 黑K 突破`, () => {
    const candles = computeIndicators(lFix.candles);
    const result = detectBlackKBreakout(candles, candles.length - 1);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.isBlackKBreakout).toBe(true);
    expect(result.blackKHigh).toBeGreaterThanOrEqual(lFix.expected.blackKHighMin);
    expect(result.blackKHigh).toBeLessThanOrEqual(lFix.expected.blackKHighMax);
    expect(result.bodyPct).toBeGreaterThanOrEqual(lFix.expected.bodyPctMin);
  });
});
