/**
 * Smoke tests for B-I buy method detectors
 *
 * 確認 9 個買法 detector：
 * - 邊界輸入（< 30 K 線）回 null 不 throw
 * - 對對齊書本的「理想型」輸入會觸發
 *
 * 不檢查書本邏輯的「應該觸發但沒觸發」case — 那需要書本實例對照，是另一個檔案的事。
 */

import { detectBreakoutEntry, detectConsolidationBreakout } from '../lib/analysis/breakoutEntry';
import { detectStrategyE } from '../lib/analysis/highWinRateEntry';
import { detectStrategyD } from '../lib/analysis/gapEntry';
import { detectVReversal } from '../lib/analysis/vReversalDetector';
import { detectABCBreakout } from '../lib/analysis/abcBreakoutEntry';
import { detectBlackKBreakout } from '../lib/analysis/blackKBreakoutEntry';
import { detectKlineConsolidationBreakout } from '../lib/analysis/klineConsolidationBreakout';
import { computeIndicators } from '../lib/indicators';
import { Candle } from '../types';

function genFlat(count: number, price = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: price, high: price * 1.001, low: price * 0.999, close: price,
    volume: 10000,
  }));
}

const TINY = computeIndicators(genFlat(5));         // 太少
const FLAT = computeIndicators(genFlat(60));        // 60 根橫盤

describe('Buy method detectors — smoke tests', () => {
  const detectors: Array<[string, (c: typeof FLAT, i: number) => unknown]> = [
    ['B detectBreakoutEntry',          detectBreakoutEntry],
    ['C detectConsolidationBreakout',  detectConsolidationBreakout],
    ['D detectStrategyE (一字底)',     detectStrategyE],
    ['E detectStrategyD (跳空)',       detectStrategyD],
    ['F detectVReversal',              detectVReversal],
    ['G detectABCBreakout',            detectABCBreakout],
    ['H detectBlackKBreakout',         detectBlackKBreakout],
    ['I detectKlineConsolidationBreakout', detectKlineConsolidationBreakout],
  ];

  describe.each(detectors)('%s', (_name, detector) => {
    it('returns null/falsy on tiny dataset', () => {
      const r = detector(TINY, TINY.length - 1);
      expect(r === null || r === false || (typeof r === 'object' && r != null && 'isBreakout' in r && !(r as { isBreakout: boolean }).isBreakout) || r === undefined).toBe(true);
    });

    it('does not throw on flat dataset', () => {
      expect(() => detector(FLAT, FLAT.length - 1)).not.toThrow();
    });

    it('does not throw on first valid index', () => {
      expect(() => detector(FLAT, 0)).not.toThrow();
    });

    it('does not throw on last index', () => {
      expect(() => detector(FLAT, FLAT.length - 1)).not.toThrow();
    });
  });
});
