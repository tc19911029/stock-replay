/**
 * holdingVerdict 純函式 unit tests — 0513 ABCDE B1
 *
 * 涵蓋 verdict dispatch 樹的每一條 path：
 *  1. NaN guard → 資料異常
 *  2. absoluteStopLoss → 立刻出場
 *  3. step4 klineExit → 該出場
 *  4. step4 maExit → 該出場
 *  5. step5 takeProfit → 該停利
 *  6. step5 kbarSignal → 該停利
 *  7. sellHigh（適用） → 該出場
 *  8. sellMed（適用） → 緊盯停損
 *  9. slDistancePct < 3% → 緊盯停損
 *  10. profitPct >= 10% → 可續抱
 *  11. profitPct < 0 → 緊盯停損
 *  12. default → 繼續持有
 *
 * 也驗 inapplicableSellSignals 過濾（N/F/Q/D/O 字母 BREAK_MA5 不升 verdict）
 */

import { describe, it, expect } from '@jest/globals';
import { holdingVerdict, type VerdictInput } from '../lib/portfolio/holdingVerdict';

/** 建一個 default 安全 input：所有 step3/4/5 都「沒事」、profitPct=0、letter=B */
function makeInput(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    letter: 'B',
    profitPct: 0.05,
    step3: {
      stopLossPrice: 95,
      slDistancePct: 5,
      absoluteStopLoss: { triggered: false },
    },
    step4: {
      operatingMA: 'MA5',
      klineExit: { shouldExit: false },
      maExit: { shouldExit: false },
    },
    step5: {
      takeProfit: { triggered: false },
      kbarSignal: { triggered: false },
      triggeredSellSignals: [],
    },
    ...overrides,
  };
}

describe('holdingVerdict — dispatch path', () => {
  describe('1. NaN guard', () => {
    it('profitPct=NaN → 資料異常', () => {
      const v = holdingVerdict(makeInput({ profitPct: NaN }));
      expect(v).toEqual({ level: 'warn', label: '資料異常', reason: expect.stringContaining('損益無法計算') });
    });
    it('stopLossPrice=NaN → 資料異常', () => {
      const v = holdingVerdict(makeInput({ step3: { stopLossPrice: NaN, slDistancePct: 5, absoluteStopLoss: { triggered: false } } }));
      expect(v.level).toBe('warn');
      expect(v.label).toBe('資料異常');
    });
    it('profitPct=Infinity → 資料異常', () => {
      const v = holdingVerdict(makeInput({ profitPct: Infinity }));
      expect(v.label).toBe('資料異常');
    });
  });

  describe('2. 強制出場（書本明寫硬條件）', () => {
    it('absoluteStopLoss triggered → 立刻出場', () => {
      const v = holdingVerdict(makeInput({
        step3: { stopLossPrice: 95, slDistancePct: 5, absoluteStopLoss: { triggered: true, detail: '跌破 V 底' } },
      }));
      expect(v).toEqual({ level: 'bad', label: '立刻出場', reason: '跌破 V 底' });
    });
    it('absoluteStopLoss triggered 但沒 detail → 預設文案', () => {
      const v = holdingVerdict(makeInput({
        step3: { stopLossPrice: 95, slDistancePct: 5, absoluteStopLoss: { triggered: true } },
      }));
      expect(v.reason).toBe('觸發絕對停損');
    });
  });

  describe('3-4. step4 exit', () => {
    it('klineExit shouldExit → 該出場', () => {
      const v = holdingVerdict(makeInput({
        step4: {
          operatingMA: 'MA10',
          klineExit: { shouldExit: true, reason: '收盤跌破前一日最低' },
          maExit: { shouldExit: false },
        },
      }));
      expect(v).toEqual({ level: 'bad', label: '該出場', reason: '收盤跌破前一日最低' });
    });
    it('maExit shouldExit → 該出場', () => {
      const v = holdingVerdict(makeInput({
        step4: {
          operatingMA: 'MA10',
          klineExit: { shouldExit: false },
          maExit: { shouldExit: true, reason: '收盤跌破 MA10' },
        },
      }));
      expect(v.label).toBe('該出場');
      expect(v.reason).toBe('收盤跌破 MA10');
    });
  });

  describe('5-6. step5 take profit / kbar signal', () => {
    it('takeProfit triggered → 該停利', () => {
      const v = holdingVerdict(makeInput({
        step5: {
          takeProfit: { triggered: true, detail: '達目標價 200' },
          kbarSignal: { triggered: false },
        },
      }));
      expect(v).toEqual({ level: 'bad', label: '該停利', reason: '達目標價 200' });
    });
    it('kbarSignal triggered → 該停利', () => {
      const v = holdingVerdict(makeInput({
        step5: {
          takeProfit: { triggered: false },
          kbarSignal: { triggered: true, detail: '高檔長上影' },
        },
      }));
      expect(v.label).toBe('該停利');
    });
  });

  describe('7-8. sellHigh / sellMed（inapplicableSellSignals 過濾）', () => {
    it('B 字母 + sellHigh BREAK_MA20 → 該出場（不過濾）', () => {
      const v = holdingVerdict(makeInput({
        letter: 'B',
        step5: {
          takeProfit: { triggered: false },
          kbarSignal: { triggered: false },
          triggeredSellSignals: [{ type: 'BREAK_MA20', label: '跌破月線', detail: '收盤(100) 跌破 MA20', severity: 'high' }],
        },
      }));
      expect(v.label).toBe('該出場');
    });

    it('N 字母 + BREAK_MA5 (severity=low) → 不影響 verdict（N 不適用）', () => {
      const v = holdingVerdict(makeInput({
        letter: 'N',
        profitPct: 0.05,
        step5: {
          takeProfit: { triggered: false },
          kbarSignal: { triggered: false },
          triggeredSellSignals: [{ type: 'BREAK_MA5', label: '跌破週線MA5', detail: '...', severity: 'low' }],
        },
      }));
      expect(v.label).toBe('繼續持有');
    });

    it('Q 字母 + BREAK_MA5 (severity=high) → 不影響 verdict（Q 不適用 MA5）', () => {
      const v = holdingVerdict(makeInput({
        letter: 'Q',
        profitPct: 0.05,
        step5: {
          takeProfit: { triggered: false },
          kbarSignal: { triggered: false },
          triggeredSellSignals: [{ type: 'BREAK_MA5', label: '跌破週線MA5', detail: '...', severity: 'high' }],
        },
      }));
      expect(v.label).toBe('繼續持有');
    });

    it('F 字母 + BREAK_MA10 (severity=high) → 不影響 verdict（F 不適用）', () => {
      const v = holdingVerdict(makeInput({
        letter: 'F',
        step5: {
          takeProfit: { triggered: false },
          kbarSignal: { triggered: false },
          triggeredSellSignals: [{ type: 'BREAK_MA10', label: '跌破MA10', detail: '...', severity: 'high' }],
        },
      }));
      expect(v.label).toBe('繼續持有');
    });

    it('medium severity → 緊盯停損', () => {
      const v = holdingVerdict(makeInput({
        letter: 'B',
        step5: {
          takeProfit: { triggered: false },
          kbarSignal: { triggered: false },
          triggeredSellSignals: [{ type: 'KD_DEATH_CROSS', label: 'KD高位死叉', detail: 'KD 跌破...', severity: 'medium' }],
        },
      }));
      expect(v.label).toBe('緊盯停損');
    });
  });

  describe('9. slDistancePct < 3%', () => {
    it('slDistancePct = 2.5% → 緊盯停損', () => {
      const v = holdingVerdict(makeInput({
        step3: { stopLossPrice: 97.5, slDistancePct: 2.5, absoluteStopLoss: { triggered: false } },
      }));
      expect(v.level).toBe('warn');
      expect(v.label).toBe('緊盯停損');
      expect(v.reason).toContain('現價距停損僅');
    });
    it('slDistancePct = 0 → 不算近停損（boundary）', () => {
      const v = holdingVerdict(makeInput({
        step3: { stopLossPrice: 95, slDistancePct: 0, absoluteStopLoss: { triggered: false } },
      }));
      // slDistancePct > 0 才觸發；=0 跳過
      expect(v.label).not.toBe('緊盯停損');
    });
    it('slDistancePct = 3% → 不觸發（boundary < 3）', () => {
      const v = holdingVerdict(makeInput({
        step3: { stopLossPrice: 97, slDistancePct: 3, absoluteStopLoss: { triggered: false } },
      }));
      expect(v.label).not.toBe('緊盯停損');
    });
  });

  describe('10-11. profitPct buckets', () => {
    it('profitPct = 12% → 可續抱', () => {
      const v = holdingVerdict(makeInput({ profitPct: 0.12, step4: { operatingMA: 'MA5', klineExit: { shouldExit: false }, maExit: { shouldExit: false } } }));
      expect(v).toEqual({ level: 'good', label: '可續抱', reason: expect.stringContaining('已達 12.0%') });
    });
    it('profitPct = -5% → 緊盯停損', () => {
      const v = holdingVerdict(makeInput({
        profitPct: -0.05,
        step3: { stopLossPrice: 93, slDistancePct: 10, absoluteStopLoss: { triggered: false } },  // slDistance > 3 避免被前一條捕獲
      }));
      expect(v.level).toBe('warn');
      expect(v.label).toBe('緊盯停損');
      expect(v.reason).toContain('虧損');
    });
    it('profitPct = 5%（介於 0-10%）→ 繼續持有', () => {
      const v = holdingVerdict(makeInput({ profitPct: 0.05 }));
      expect(v.label).toBe('繼續持有');
    });
    it('profitPct = 10%（boundary） → 可續抱', () => {
      const v = holdingVerdict(makeInput({ profitPct: 0.10 }));
      expect(v.label).toBe('可續抱');
    });
  });

  describe('12. default', () => {
    it('全部正常 → 繼續持有', () => {
      const v = holdingVerdict(makeInput());
      expect(v.level).toBe('good');
      expect(v.label).toBe('繼續持有');
      expect(v.reason).toContain('多頭延續');
    });
  });

  describe('dispatch 順序（先匹配先回）', () => {
    it('absoluteStopLoss 優先於 step4 maExit', () => {
      const v = holdingVerdict(makeInput({
        step3: { stopLossPrice: 95, slDistancePct: 5, absoluteStopLoss: { triggered: true, detail: 'A' } },
        step4: {
          operatingMA: 'MA5',
          klineExit: { shouldExit: false },
          maExit: { shouldExit: true, reason: 'B' },
        },
      }));
      expect(v.label).toBe('立刻出場');
      expect(v.reason).toBe('A');
    });

    it('step4 klineExit 優先於 step5 takeProfit', () => {
      const v = holdingVerdict(makeInput({
        step4: {
          operatingMA: 'MA5',
          klineExit: { shouldExit: true, reason: 'A' },
          maExit: { shouldExit: false },
        },
        step5: {
          takeProfit: { triggered: true, detail: 'B' },
          kbarSignal: { triggered: false },
        },
      }));
      expect(v.label).toBe('該出場');
      expect(v.reason).toBe('A');
    });

    it('sellHigh 優先於 slDistance', () => {
      const v = holdingVerdict(makeInput({
        letter: 'B',
        step3: { stopLossPrice: 97.5, slDistancePct: 2.5, absoluteStopLoss: { triggered: false } },
        step5: {
          takeProfit: { triggered: false },
          kbarSignal: { triggered: false },
          triggeredSellSignals: [{ type: 'BREAK_MA20', label: '跌破月線', detail: '...', severity: 'high' }],
        },
      }));
      expect(v.label).toBe('該出場');  // 該出場 > 緊盯停損
    });

    it('slDistance 優先於 profitPct >= 10%', () => {
      const v = holdingVerdict(makeInput({
        profitPct: 0.12,
        step3: { stopLossPrice: 97.5, slDistancePct: 2.5, absoluteStopLoss: { triggered: false } },
      }));
      expect(v.label).toBe('緊盯停損');
    });
  });
});
