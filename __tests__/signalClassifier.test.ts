/**
 * signalClassifier — 鎖住每個已知 ruleId 的 subtype 分類
 *
 * 為什麼鎖死：subtype 直接影響 SignalSummaryCard 的 verdict（可進場 / 觀察 / 該出場 等）。
 * 任何 ruleId 改類別要先過這支 test，避免無聲影響 UI 行為。
 *
 * 2026-05-11 補 — 修 1721 三晃 verdict 誤判（朱SOP/破底穿頭 被 default 路徑變 entry_soft）
 */

import { classifySignal, type SignalSubtype } from '@/lib/rules/signalClassifier';
import type { RuleSignal } from '@/types';

function mk(type: RuleSignal['type'], ruleId: string, label = ''): RuleSignal {
  return { type, ruleId, label, description: '', reason: '' };
}

describe('signalClassifier — ruleId lookup', () => {
  // ── 進場硬訊號 ────────────────────────────────────────────────────
  describe('entry_strong', () => {
    test.each([
      ['zhu-short-bull-sop', '朱SOP做多'],
      ['zhu-bull-pullback-entry', '回後買上漲'],
      ['zhu-bull-breakout-entry', '盤整突破'],
      ['zhu-bull-ma-support-entry', '均線支撐'],
      ['zhu-flat-bottom-breakout', '一字底突破'],
      ['zhu-higher-bottom-breakout', '底底高突破'],
      ['zhu-false-breakdown-breakout', '破底穿頭(最強)'],
      ['zhu-consolidation-breakout-direction', '盤整突破方向'],
      ['zhu-rising-sun', '上升旭日'],
      ['zhu-bullish-engulfing-low', '低檔長紅吞噬'],
      ['zhu-bullish-piercing-low', '低檔長紅貫穿'],
      ['zhu-morning-star-low', '早晨之星'],
      ['zhu-bullish-double-star', '多頭雙星變盤'],
      ['zhu-golden-right-foot', '黃金右腳'],
      ['zhu-ma-bottom-confirm', '均線打底完成'],
      ['zhu-turning-wave-10ma-bull', '中線轉折波多頭'],
      ['zhu-turning-wave-20ma-bull', '長線轉折波多頭'],
      ['zhu-turning-wave-triple-bull', '三線轉折波共振多頭'],
      ['sop-bull-confirm-entry', '走圖SOP多頭確認'],
      ['sop-bull-pullback-buy', '走圖SOP回後買上漲'],
      ['sop-consolidation-breakout', '走圖SOP盤整突破'],
      ['gap-up-long-red', '缺口長紅做多'],
      ['gap-three-day-two-gaps-up', '三日二缺口漲'],
      ['kline-one-star-two-yang', '一星二陽續漲'],
      ['kline-rising-three-methods', '上升三法續漲'],
      ['kline-three-line-reverse-red', '三線反紅續攻'],
      ['kline-three-consecutive-red', '連三紅強勢'],
      ['kline-down-gap-filled', '下缺回補反轉'],
      ['kline-trading-bull-entry', 'K線交易法買進'],
      ['kline-v-shape-reversal-buy', 'V形反轉搶反彈'],
      ['long-term-select-monthly', '長線選股1'],
      ['long-term-select-weekly', '長線選股2'],
      ['long-term-select-daily', '長線選股3'],
      ['long-term-entry', '長線操作1'],
      ['long-term-second-wave', '長線操作7'],
      ['single-ma20-buy', '一條均線買進'],
      ['triple-ma-golden-cross-buy', '三條均線買進'],
      ['dual-ma10-ma24-buy', '二條均線買進'],
      ['surge-stock-breakout', '飆股突破'],
      ['momentum-continuation-buy', '續勢買進'],
      ['zhu-surge-long-consol-break', '飆股條件3'],
      ['zhu-surge-double-bottom', '飆股條件4'],
      ['zhu-surge-ma-cluster', '飆股條件5'],
      ['zhu-surge-downtrend-break', '飆股條件6'],
      ['low-long-red-attack', '低檔長紅攻擊'],
      ['low-engulf-attack', '低檔陽包陰'],
      ['weekly-ma20-buy', '20週均線買進'],
      ['weekly-ma20-add-near-support', '20週均線加碼'],
      ['granville-buy-1', '葛蘭碧①'],
      ['granville-buy-2', '葛蘭碧②'],
      ['granville-buy-3', '葛蘭碧③'],
      ['bollinger-squeeze-up', '布林壓縮突破'],
    ])('ruleId=%s (%s) → entry_strong', (ruleId, label) => {
      expect(classifySignal(mk('BUY', ruleId, label))).toBe<SignalSubtype>('entry_strong');
    });
  });

  // ── 進場軟訊號 ────────────────────────────────────────────────────
  describe('entry_soft', () => {
    test.each([
      ['zhu-bullish-harami-low', '低檔母子懷抱'],
      ['zhu-bullish-mother-son-transition', '低檔母子變盤'],
      ['zhu-turning-wave-5ma-bull', '短線轉折波多頭'],
      ['candle-merge-signal', '子母線'],
      ['low-hammer-attack', '低檔鎚子止跌'],
      ['low-cross-attack', '低檔十字變盤'],
      ['low-three-red-attack', '低檔連三紅'],
      ['sop-low-reversal-signal', '走圖SOP低檔變盤'],
      ['granville-buy-4', '葛蘭碧④反彈'],
      ['zhu-price-volume-9', '價漲量增'],
      ['zhu-takeprofit-low-climax-bear', '低檔急跌回補'],
    ])('ruleId=%s (%s) → entry_soft', (ruleId, label) => {
      expect(classifySignal(mk('BUY', ruleId, label))).toBe<SignalSubtype>('entry_soft');
    });
  });

  // ── 出場硬訊號 ────────────────────────────────────────────────────
  describe('exit_strong', () => {
    test.each([
      ['sop-bear-confirm-entry', '走圖SOP空頭確認'],
      ['sop-bear-bounce-sell', '走圖SOP彈後空下跌'],
      ['sop-consolidation-breakdown', '走圖SOP盤整跌破'],
      ['gap-down-long-black', '缺口長黑做空'],
      ['gap-three-day-two-gaps-down', '三日二缺口跌'],
      ['kline-three-line-reverse-black', '三線反黑反轉'],
      ['kline-inner-three-black', '內困三黑反轉'],
      ['kline-three-consecutive-black', '連三黑空方強'],
      ['kline-trading-bull-exit', 'K線交易法賣出'],
      ['kline-inverted-v-reversal-sell', '倒V反轉搶回檔'],
      ['kline-major-resistance-ahead', '大敵當前出貨'],
      ['kline-one-star-two-yin', '一星二陰續跌'],
      ['kline-falling-three-methods', '下降三法續跌'],
      ['kline-black-red-black', '黑紅黑誘多'],
      ['zhu-flat-top-breakdown', '平頭破底'],
      ['zhu-lower-top-breakdown', '低頭破底'],
      ['zhu-false-breakout-breakdown', '穿頭破底(最弱)'],
      ['zhu-dark-cloud-cover', '烏雲蓋頂'],
      ['zhu-bearish-engulfing-high', '高檔長黑吞噬'],
      ['zhu-bearish-piercing-high', '高檔長黑貫穿'],
      ['zhu-bearish-double-star', '空頭雙星變盤'],
      ['zhu-evening-star-high', '高檔暮星'],
      ['zhu-short-bear-sop', '朱SOP做空'],
      ['zhu-bear-bounce-entry', '反彈再下跌'],
      ['zhu-bear-breakdown-entry', '盤整跌破'],
      ['zhu-bear-break-low-entry', '大量破低'],
      ['zhu-bear-engulf-entry', '空頭吞噬'],
      ['zhu-stoploss-kline-low', '停損出場'],
      ['zhu-stoploss-trend-change', '趨勢變停損'],
      ['zhu-stoploss-max-10pct', '10%停損'],
      ['zhu-long-trend-ma20-exit', '破MA20出場'],
      ['zhu-short-kline-exit', 'K線轉折'],
      ['zhu-short-ma5-exit', '破MA5出場'],
      ['zhu-takeprofit-10pct', '10%停利'],
      ['zhu-takeprofit-high-climax-bull', '高檔急漲停利'],
      ['zhu-takeprofit-resistance', '壓力區停利'],
      ['zhu-turning-wave-20ma-bear', '長線轉折波空頭'],
      ['zhu-turning-wave-triple-bear', '三線轉折波共振空頭'],
      ['surge-stock-exit', '飆股出場'],
      ['zhu-surge-hold-or-sell', '飆股出場'],
      ['high-shooting-star', '高檔射擊之星'],
      ['high-engulf-sell', '高檔陰包陽'],
      ['high-evening-star', '高檔暮星'],
      ['single-ma20-sell', '一條均線賣出'],
      ['triple-ma-death-cross-sell', '三條均線賣出'],
      ['dual-ma10-ma24-sell', '二條均線賣出'],
      ['weekly-ma20-sell', '20週均線賣出'],
      ['long-term-head-lower-exit', '長線操作3'],
      ['granville-sell-5', '葛蘭碧⑤'],
      ['granville-sell-6', '葛蘭碧⑥'],
      ['granville-sell-7', '葛蘭碧⑦'],
      ['bollinger-squeeze-down', '布林壓縮跌破'],
    ])('ruleId=%s (%s) → exit_strong', (ruleId, label) => {
      expect(classifySignal(mk('SELL', ruleId, label))).toBe<SignalSubtype>('exit_strong');
    });
  });

  // ── 出場軟訊號 ────────────────────────────────────────────────────
  describe('exit_soft', () => {
    test.each([
      ['zhu-bearish-mother-son-transition', '高檔母子變盤'],
      ['zhu-bearish-harami-high', '高檔母子懷抱'],
      ['sop-high-reversal-warning', '走圖SOP高檔變盤'],
      ['high-cross-sell', '高檔十字變盤'],
      ['long-term-profit-take', '長線停利'],
      ['long-term-doubled-warning', '近期已漲一倍'],
      ['granville-sell-8', '葛蘭碧⑧停利'],
      ['zhu-turning-wave-5ma-bear', '短線轉折波空頭'],
      ['zhu-turning-wave-10ma-bear', '中線轉折波空頭'],
      ['kline-up-gap-filled', '上缺回補反轉'],
      ['smart-kline-sell', '智慧K線賣出'],
    ])('ruleId=%s (%s) → exit_soft', (ruleId, label) => {
      expect(classifySignal(mk('SELL', ruleId, label))).toBe<SignalSubtype>('exit_soft');
    });
  });

  // ── 警示型 ────────────────────────────────────────────────────────
  describe('warn', () => {
    test.each([
      ['zhu-bias-warning', '高乖離'],
      ['zhu-position-risk', '山頂位置'],
      ['zhu-market-cycle-4stage', '打底期'],
      ['zhu-surge-volume-5types', '攻擊量'],
      ['zhu-accumulation-volume', '量增打底'],
      ['zhu-half-price-strength', '半值線強勢'],
    ])('ruleId=%s (%s) → warn', (ruleId, label) => {
      expect(classifySignal(mk('WATCH', ruleId, label))).toBe<SignalSubtype>('warn');
    });
  });

  // ── 雙向 detector（type:ruleId 複合鍵） ────────────────────────
  describe('dual-direction detectors (type:ruleId)', () => {
    test('gap-island-reversal BUY → entry_strong', () => {
      expect(classifySignal(mk('BUY', 'gap-island-reversal', '底部島狀反轉'))).toBe<SignalSubtype>('entry_strong');
    });
    test('gap-island-reversal SELL → exit_strong', () => {
      expect(classifySignal(mk('SELL', 'gap-island-reversal', '高檔島狀反轉'))).toBe<SignalSubtype>('exit_strong');
    });
  });

  // ── WATCH 攔截在 lookup 前 ────────────────────────────────────
  describe('WATCH always → warn (overrides ruleId lookup)', () => {
    test('WATCH on a BUY-classified ruleId still → warn', () => {
      // 例：某些 detector 在條件未完全成立時 emit WATCH，這時不該被 lookup 升級成 entry_strong
      expect(classifySignal(mk('WATCH', 'zhu-short-bull-sop', '朱SOP觀察'))).toBe<SignalSubtype>('warn');
    });
  });

  // ── Detector 自帶 subtype 最權威 ────────────────────────────────
  describe('respects sig.subtype if provided', () => {
    test('subtype overrides ruleId lookup', () => {
      const sig: RuleSignal = {
        type: 'BUY',
        ruleId: 'zhu-short-bull-sop',
        label: '朱SOP做多',
        description: '',
        reason: '',
        subtype: 'entry_soft',
      };
      expect(classifySignal(sig)).toBe<SignalSubtype>('entry_soft');
    });
  });

  // ── Default fallback ─────────────────────────────────────────────
  describe('unknown ruleId falls back to default', () => {
    test('unknown BUY → entry_soft (保守)', () => {
      expect(classifySignal(mk('BUY', 'made-up-rule-id', '隨便'))).toBe<SignalSubtype>('entry_soft');
    });
    test('unknown SELL → exit_strong (保守，寧可早出場)', () => {
      expect(classifySignal(mk('SELL', 'made-up-rule-id', '隨便'))).toBe<SignalSubtype>('exit_strong');
    });
    test('WATCH → warn', () => {
      expect(classifySignal(mk('WATCH', 'made-up-rule-id', '隨便'))).toBe<SignalSubtype>('warn');
    });
  });
});
