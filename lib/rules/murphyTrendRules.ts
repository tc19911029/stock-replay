// ═══════════════════════════════════════════════════════════════
// Murphy《金融市場技術分析》第4章
// 趨勢結構規則 — 支撐阻擋互換、趨勢線突破、回撤、管道線、跳空
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';
import {
  findSwingHighs, findSwingLows, linearRegression,
  gapUp, gapDown, isVolumeBreakout, isLongRedCandle,
} from './ruleUtils';

// ── 工具函數 ──────────────────────────────────────────────────────────────────

/** 計算趨勢線在指定 index 處的預測值 */
function trendlineValue(reg: { slope: number; intercept: number }, idx: number): number {
  return reg.slope * idx + reg.intercept;
}

/** 找近 lookback 根內的區間最高/最低 */
function rangeHighLow(candles: CandleWithIndicators[], index: number, lookback: number) {
  let high = -Infinity;
  let low = Infinity;
  const start = Math.max(0, index - lookback);
  for (let i = start; i <= index; i++) {
    if (candles[i].high > high) high = candles[i].high;
    if (candles[i].low < low) low = candles[i].low;
  }
  return { high, low };
}

// ── 規則 ──────────────────────────────────────────────────────────────────────

/**
 * 支撐阻擋角色互換（多頭）
 * Murphy 第4章：被突破的阻擋水平變成新的支撐，價格回踩確認後為買入機會
 */
export const supportResistanceFlipBuy: TradingRule = {
  id: 'murphy-sr-flip-buy',
  name: '支撐阻擋角色互換（買入）',
  description: '價格突破阻擋後回踩該水平獲得支撐，確認角色互換',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    // 找近60根的局部高點作為過去的阻擋
    const swingHighs = findSwingHighs(candles, index, 60, 3);
    if (swingHighs.length < 2) return null;

    for (const sh of swingHighs) {
      const resistLevel = sh.price;
      // 條件1：價格曾突破該阻擋（之後至少有5根收在其上方）
      let daysAbove = 0;
      for (let i = sh.idx + 1; i < index; i++) {
        if (candles[i].close > resistLevel) daysAbove++;
      }
      if (daysAbove < 5) continue;

      // 條件2：當前回踩到該水平附近（在 ±3% 範圍內）
      const tolerance = resistLevel * 0.03;
      if (c.low > resistLevel + tolerance || c.low < resistLevel - tolerance) continue;

      // 條件3：當日收紅且收在該水平之上
      if (c.close <= c.open || c.close < resistLevel) continue;

      return {
        type: 'BUY',
        label: '阻擋轉支撐',
        description: `價格回踩前阻擋 ${resistLevel.toFixed(2)} 獲得支撐，收紅站穩`,
        reason: [
          '【出處】Murphy《金融市場技術分析》第4章 — 趨勢的基本概念',
          '原理：被有效突破的阻擋水平，其性質會轉變為支撐。',
          '原因：在該價位附近曾經有大量賣壓（阻擋），突破後這些賣方變成了多方，',
          '當價格回踩時他們傾向買入以保護部位，形成支撐。',
          '操作：在回踩確認支撐後買入，止損設在該水平下方。',
        ].join('\n'),
        ruleId: this.id,
      };
    }
    return null;
  },
};

/**
 * 支撐阻擋角色互換（空頭）
 * Murphy 第4章：被跌破的支撐水平變成新的阻擋
 */
export const supportResistanceFlipSell: TradingRule = {
  id: 'murphy-sr-flip-sell',
  name: '支撐阻擋角色互換（賣出）',
  description: '價格跌破支撐後反彈至該水平遇阻，確認角色互換',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    const swingLows = findSwingLows(candles, index, 60, 3);
    if (swingLows.length < 2) return null;

    for (const sl of swingLows) {
      const supportLevel = sl.price;
      // 條件1：價格曾跌破該支撐（之後至少有5根收在其下方）
      let daysBelow = 0;
      for (let i = sl.idx + 1; i < index; i++) {
        if (candles[i].close < supportLevel) daysBelow++;
      }
      if (daysBelow < 5) continue;

      // 條件2：當前反彈到該水平附近
      const tolerance = supportLevel * 0.03;
      if (c.high < supportLevel - tolerance || c.high > supportLevel + tolerance) continue;

      // 條件3：當日收黑且收在該水平之下
      if (c.close >= c.open || c.close > supportLevel) continue;

      return {
        type: 'SELL',
        label: '支撐轉阻擋',
        description: `價格反彈至前支撐 ${supportLevel.toFixed(2)} 遇阻，收黑壓回`,
        reason: [
          '【出處】Murphy《金融市場技術分析》第4章 — 趨勢的基本概念',
          '原理：被有效跌破的支撐水平，其性質會轉變為阻擋。',
          '原因：在該價位附近的多方被套牢，當價格反彈至此時傾向賣出解套。',
          '操作：反彈遇阻回落時賣出，或設止損在該水平上方。',
        ].join('\n'),
        ruleId: this.id,
      };
    }
    return null;
  },
};

/**
 * 上升趨勢線突破（看跌警告）
 * Murphy 第4章：連接至少3個 swing lows 的上升趨勢線被跌破
 */
export const uptrendLineBreak: TradingRule = {
  id: 'murphy-uptrend-line-break',
  name: '上升趨勢線跌破',
  description: '連接多個波谷的上升趨勢線被收盤價跌破，趨勢可能反轉',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    // 找近80根的 swing lows
    const lows = findSwingLows(candles, index, 80, 3);
    if (lows.length < 3) return null;

    // 用後3個 swing lows 做線性回歸（需上升斜率）
    const recent = lows.slice(-3);
    const points = recent.map(p => ({ x: p.idx, y: p.price }));
    const reg = linearRegression(points);

    // 條件1：趨勢線向上（斜率 > 0）
    if (reg.slope <= 0) return null;

    // 條件2：擬合良好 (R² > 0.7)
    if (reg.r2 < 0.7) return null;

    // 條件3：當前收盤跌破趨勢線
    const lineVal = trendlineValue(reg, index);
    if (c.close >= lineVal) return null;

    // 條件4：前一日收盤還在趨勢線上方
    const prevLineVal = trendlineValue(reg, index - 1);
    if (candles[index - 1].close < prevLineVal) return null;

    return {
      type: 'SELL',
      label: '上升趨勢線跌破',
      description: `收盤 ${c.close.toFixed(2)} 跌破上升趨勢線 ${lineVal.toFixed(2)}`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第4章 — 趨勢線',
        '原理：上升趨勢線被有效跌破，通常是趨勢反轉或至少暫停的信號。',
        '趨勢線越長、被觸及次數越多，其突破的意義越重大。',
        '注意：需要配合交易量和其他指標確認，避免假突破。',
        '操作：跌破趨勢線後考慮減碼或出場，等待趨勢明朗化。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 下降趨勢線突破（看漲信號）
 * Murphy 第4章：連接至少3個 swing highs 的下降趨勢線被突破
 */
export const downtrendLineBreak: TradingRule = {
  id: 'murphy-downtrend-line-break',
  name: '下降趨勢線突破',
  description: '連接多個波峰的下降趨勢線被收盤價突破，趨勢可能反轉',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    const highs = findSwingHighs(candles, index, 80, 3);
    if (highs.length < 3) return null;

    const recent = highs.slice(-3);
    const points = recent.map(p => ({ x: p.idx, y: p.price }));
    const reg = linearRegression(points);

    // 條件1：趨勢線向下（斜率 < 0）
    if (reg.slope >= 0) return null;

    // 條件2：擬合良好
    if (reg.r2 < 0.7) return null;

    // 條件3：當前收盤突破趨勢線
    const lineVal = trendlineValue(reg, index);
    if (c.close <= lineVal) return null;

    // 條件4：前一日還在趨勢線下方
    const prevLineVal = trendlineValue(reg, index - 1);
    if (candles[index - 1].close > prevLineVal) return null;

    // 配合交易量放大更佳
    const volConfirm = isVolumeBreakout(c, 1.3);

    return {
      type: 'BUY',
      label: '下降趨勢線突破',
      description: `收盤 ${c.close.toFixed(2)} 突破下降趨勢線 ${lineVal.toFixed(2)}${volConfirm ? '，帶量確認' : ''}`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第4章 — 趨勢線',
        '原理：下降趨勢線被有效突破，是潛在趨勢反轉的第一個信號。',
        '突破時如配合成交量放大，信號更為可靠。',
        '操作：突破後等待回測確認，或在突破時即入場，止損設在趨勢線下方。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 50%回撤買入機會
 * Murphy 第4章：上升趨勢中回撤到 38.2%-61.8% 區間時出現反彈信號
 */
export const fiftyPercentRetracement: TradingRule = {
  id: 'murphy-50pct-retracement',
  name: '50%回撤反彈',
  description: '上升趨勢中回撤至38%-62%區間並出現止跌信號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    // 找近60根的最高和最低
    const { high: swingHigh, low: swingLow } = rangeHighLow(candles, index, 60);
    const range = swingHigh - swingLow;
    if (range <= 0) return null;

    // 最高點必須出現在最低點之後（是上升後的回撤）
    let highIdx = 0, lowIdx = 0;
    for (let i = Math.max(0, index - 60); i <= index; i++) {
      if (candles[i].high === swingHigh) highIdx = i;
      if (candles[i].low === swingLow) lowIdx = i;
    }
    // 需要先有低點，再有高點（上升趨勢），然後回撤
    if (highIdx <= lowIdx) return null;
    if (highIdx >= index - 2) return null; // 高點不能太近

    // 計算回撤比例
    const retracement = (swingHigh - c.close) / range;

    // 條件：回撤在 33%-66% 之間（Murphy 的經典回撤區間）
    if (retracement < 0.33 || retracement > 0.66) return null;

    // 條件：當日收紅（止跌反彈信號）
    if (c.close <= c.open) return null;

    // 條件：MA20 仍然上揚（大趨勢仍向上）
    if (c.ma20 == null) return null;
    const prevMa20 = candles[index - 3]?.ma20;
    if (prevMa20 == null || c.ma20 <= prevMa20) return null;

    const retPct = (retracement * 100).toFixed(1);
    const level = retracement <= 0.44 ? '38.2%' : retracement <= 0.56 ? '50%' : '61.8%';

    return {
      type: 'BUY',
      label: `${level}回撤反彈`,
      description: `從高點 ${swingHigh.toFixed(2)} 回撤 ${retPct}% 至 ${c.close.toFixed(2)}，收紅止跌`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第4章 — 百分比回撤',
        `原理：上升趨勢中的正常回撤通常在 33%-66% 之間，目前回撤約 ${retPct}%。`,
        '最常見的回撤幅度為 50%，費波納奇水平為 38.2% 和 61.8%。',
        '回撤超過 66% 則趨勢反轉的可能性增大。',
        '操作：在回撤區間出現止跌信號時買入，止損設在 66% 回撤位下方。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 突破跳空確認
 * Murphy 第4章：跳空出現在重要的價格突破之後，通常不會被回補
 */
export const breakawayGapSignal: TradingRule = {
  id: 'murphy-breakaway-gap',
  name: '突破跳空',
  description: '在重要支撐/阻擋突破時出現跳空缺口，配合放量確認',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 向上突破跳空
    if (gapUp(prev, c)) {
      // 條件：帶量（至少 1.5 倍均量）
      if (!isVolumeBreakout(c, 1.5)) return null;

      // 條件：跳空前有整理期（前10根波動小）
      let consolidation = true;
      const { high: rangeHi, low: rangeLo } = rangeHighLow(candles, index - 1, 10);
      const rangeSpread = (rangeHi - rangeLo) / rangeLo;
      if (rangeSpread > 0.15) consolidation = false;
      if (!consolidation) return null;

      // 條件：收長紅
      if (!isLongRedCandle(c)) return null;

      return {
        type: 'BUY',
        label: '突破跳空',
        description: `向上跳空突破（缺口 ${prev.high.toFixed(2)}→${c.low.toFixed(2)}），帶量長紅`,
        reason: [
          '【出處】Murphy《金融市場技術分析》第4章 — 價格跳空',
          '原理：突破跳空出現在重要的價格突破時（如整理形態完成），通常不會被回補。',
          '突破跳空配合大成交量，是強烈的趨勢啟動信號。',
          '缺口本身成為日後的支撐區域。',
          '操作：跳空突破後進場做多，止損設在缺口下緣。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    // 向下突破跳空
    if (gapDown(prev, c)) {
      if (!isVolumeBreakout(c, 1.5)) return null;

      let consolidation = true;
      const { high: rangeHi, low: rangeLo } = rangeHighLow(candles, index - 1, 10);
      const rangeSpread = (rangeHi - rangeLo) / rangeLo;
      if (rangeSpread > 0.15) consolidation = false;
      if (!consolidation) return null;

      if (c.close >= c.open) return null; // 需收黑

      return {
        type: 'SELL',
        label: '向下突破跳空',
        description: `向下跳空跌破（缺口 ${prev.low.toFixed(2)}→${c.high.toFixed(2)}），帶量長黑`,
        reason: [
          '【出處】Murphy《金融市場技術分析》第4章 — 價格跳空',
          '原理：向下的突破跳空出現在支撐位跌破時，通常不會被回補。',
          '缺口本身成為日後的阻擋區域。',
          '操作：跳空跌破後應出場觀望或做空，止損設在缺口上緣。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    return null;
  },
};

// ── 匯出 ──────────────────────────────────────────────────────────────────────

export const MURPHY_TREND_RULES: TradingRule[] = [
  supportResistanceFlipBuy,
  supportResistanceFlipSell,
  uptrendLineBreak,
  downtrendLineBreak,
  fiftyPercentRetracement,
  breakawayGapSignal,
];
