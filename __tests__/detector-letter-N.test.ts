/**
 * 0513 ABCDE B3 — detectLetterN 真實 fixture unit test
 *
 * 用真實 K 線（從 data/candles/TW/ 拷貝）+ production indicator 計算
 * 驗 detector 對該歷史日期回的型態 / 頸線 / 目標價跟 lockwatch 紀錄一致。
 *
 * fixture 格式：
 *   {
 *     symbol, triggerDate, expected: { triggered, patternType, neckline, target },
 *     candles: [{ date, open, high, low, close, volume }, ...]
 *   }
 *
 * 加新字母 fixture：
 *   1. 從 lockwatch snapshot 找 stage='observation' + daysObserved<=1 的 record
 *   2. node -e "..." 切該股 80 根 K 線到 __tests__/fixtures/candles/
 *   3. 仿這檔寫 test
 */

import { describe, it, expect } from '@jest/globals';
import { detectLetterN } from '../lib/analysis/v12LetterN';
import { computeIndicators } from '../lib/indicators';
import triggeredFixture from './fixtures/candles/2467-N-head-shoulder-2026-05-12.json';
import boundaryFixture from './fixtures/candles/3036-N-rounding-bottom-2026-05-11.json';

describe('detectLetterN — 真實 fixture', () => {
  it(`${triggeredFixture.symbol} @ ${triggeredFixture.triggerDate} → 頭肩底真突破觸發`, () => {
    const candles = computeIndicators(triggeredFixture.candles);
    const lastIdx = candles.length - 1;
    expect(candles[lastIdx].date).toBe(triggeredFixture.triggerDate);

    const result = detectLetterN(candles, lastIdx, 'TW', triggeredFixture.symbol);

    expect(result.triggered).toBe(triggeredFixture.expected.triggered);
    expect(result.patternType).toBe(triggeredFixture.expected.patternType);
    // 頸線/目標價跟 lockwatch 紀錄一致
    expect(result.necklinePrice).toBeCloseTo(triggeredFixture.expected.necklinePrice, 0);
    expect(result.patternTargetPrice).toBeCloseTo(triggeredFixture.expected.patternTargetPrice, 0);
  });

  // 0513 B3 root cause 學到的 boundary case：漲停 K 線（open=close=high）body=0，
  // detectLetterN 內 isValidRedK 要 body ≥ 2% → 即使型態正確、close 過真突破門檻，
  // 仍 return triggered=false。書本合理（漲停日無法驗證攻擊紅 K）。
  it(`${boundaryFixture.symbol} @ ${boundaryFixture.triggerDate} → 漲停日 body=0 detector 不觸發（boundary case）`, () => {
    const candles = computeIndicators(boundaryFixture.candles);
    const lastIdx = candles.length - 1;
    const last = candles[lastIdx];

    // 確認確實是漲停（open=close=high）
    expect(last.open).toBe(last.close);
    expect(last.close).toBe(last.high);

    const result = detectLetterN(candles, lastIdx, 'TW', boundaryFixture.symbol);

    // 漲停日 body%=0 < BOOK_BODY_PCT_MIN(2%) → detector 設計上不觸發
    expect(result.triggered).toBe(false);
    expect(result.detail).toContain('未觸發');

    // 但結構檢測仍能找到型態（給 lockwatch 用）— production lockwatch 5/12 對 3036 5/11 的紀錄
    // 用的是另一條路徑（lockwatch 寫入時 daily-writer 或前一日預掃時觸發），不是這天的 detectLetterN
  });
});
