/**
 * 0513 ABCDE B3 — detectStrategyD (字母 E：跳空上漲) 真實 fixture unit test
 *
 * 注意：scanner 把 detectStrategyD（跳空進場）mapping 成字母 E
 * （function 名 strategyD 但 scan letter E — 是 04-21 重整時的命名歷史包袱）。
 *
 * 書本依據：《做對5個實戰步驟》p.40 做多位置 4「跳空上漲」+ Part 9 缺口篇 p.591-602。
 *
 * 8213.TW 5/11 為 scan-TW-long-E-2026-05-11 hit 第一名 —
 *   缺口+1.30%、實體+7.18%、量比×6.04。
 */

import { describe, it, expect } from '@jest/globals';
import { detectStrategyD } from '../lib/analysis/gapEntry';
import { computeIndicators } from '../lib/indicators';
import triggeredFixture from './fixtures/candles/8213-E-gap-up-2026-05-11.json';

describe('detectStrategyD (E：跳空上漲) — 真實 fixture', () => {
  it(`${triggeredFixture.symbol} @ ${triggeredFixture.triggerDate} → 跳空上漲觸發`, () => {
    const candles = computeIndicators(triggeredFixture.candles);
    const lastIdx = candles.length - 1;
    expect(candles[lastIdx].date).toBe(triggeredFixture.triggerDate);

    const result = detectStrategyD(candles, lastIdx);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.isGapEntry).toBe(true);
    expect(result.gapPct).toBeGreaterThanOrEqual(triggeredFixture.expected.gapPctMin);
    expect(result.bodyPct).toBeGreaterThanOrEqual(triggeredFixture.expected.bodyPctMin);
    expect(result.volumeRatio).toBeGreaterThanOrEqual(triggeredFixture.expected.volumeRatioMin);
  });
});
