// ═══════════════════════════════════════════════════════════════
// Murphy《金融市場技術分析》第4章、第13章
// 回撤與費波納奇規則 — 38.2%/61.8%支撐、1.618倍延伸、1/3-2/3回撤
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';
import { findSwingHighs, findSwingLows, SwingPoint } from './ruleUtils';

// ── 工具函數 ──────────────────────────────────────────────────────────────────

/** 找最近一段上漲波段的高點和低點 */
function findLastUpswing(
  candles: CandleWithIndicators[], index: number,
): { swingHigh: SwingPoint; swingLow: SwingPoint } | null {
  const highs = findSwingHighs(candles, index, 80, 3);
  const lows = findSwingLows(candles, index, 80, 3);
  if (highs.length === 0 || lows.length === 0) return null;

  // 找最近的高點
  const swingHigh = highs[highs.length - 1];

  // 找該高點之前最近的低點
  let swingLow: SwingPoint | null = null;
  for (let i = lows.length - 1; i >= 0; i--) {
    if (lows[i].idx < swingHigh.idx) {
      swingLow = lows[i];
      break;
    }
  }
  if (swingLow == null) return null;
  if (swingHigh.price <= swingLow.price) return null;

  return { swingHigh, swingLow };
}

// ── 規則 ──────────────────────────────────────────────────────────────────────

/**
 * 費波納奇 38.2% 回撤支撐
 * Murphy 第4/13章：強勢回撤的第一道支撐，通常出現在強勁趨勢中
 */
export const fib382Support: TradingRule = {
  id: 'murphy-fib-382-support',
  name: '費波納奇 38.2% 回撤支撐',
  description: '上升波段回撤至 38.2% 費波納奇水平附近獲得支撐',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    const swing = findLastUpswing(candles, index);
    if (swing == null) return null;

    const { swingHigh, swingLow } = swing;
    const range = swingHigh.price - swingLow.price;
    const fib382 = swingHigh.price - range * 0.382;

    // 條件1：當前價格在 38.2% 附近（±2%）
    const tolerance = range * 0.02;
    if (c.low > fib382 + tolerance || c.low < fib382 - tolerance) return null;

    // 條件2：高點之後有回撤（高點不是當天）
    if (swingHigh.idx >= index - 3) return null;

    // 條件3：當日收紅（在該水平獲得支撐）
    if (c.close <= c.open) return null;

    return {
      type: 'BUY',
      label: 'Fib 38.2% 支撐',
      description: `從 ${swingLow.price.toFixed(2)} 漲至 ${swingHigh.price.toFixed(2)} 後，回撤至 38.2% 水平 ${fib382.toFixed(2)} 獲得支撐`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第4章＆第13章 — 費波納奇回撤',
        '原理：38.2% 回撤是費波納奇數列的關鍵比例（0.618 的倒數的補數）。',
        '在強勁的上升趨勢中，回撤通常僅到 38.2% 就止住。',
        '如果回撤守住此水平，表示上升趨勢仍然強勁。',
        '操作：在 38.2% 水平出現止跌信號時買入，止損設在 50% 回撤位下方。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 費波納奇 61.8% 回撤支撐（最後防線）
 * Murphy 第4/13章：深度回撤的最後防線
 */
export const fib618Support: TradingRule = {
  id: 'murphy-fib-618-support',
  name: '費波納奇 61.8% 回撤支撐',
  description: '上升波段回撤至 61.8% 費波納奇水平（黃金比例），最後防線',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    const swing = findLastUpswing(candles, index);
    if (swing == null) return null;

    const { swingHigh, swingLow } = swing;
    const range = swingHigh.price - swingLow.price;
    const fib618 = swingHigh.price - range * 0.618;

    const tolerance = range * 0.02;
    if (c.low > fib618 + tolerance || c.low < fib618 - tolerance) return null;
    if (swingHigh.idx >= index - 3) return null;
    if (c.close <= c.open) return null;

    return {
      type: 'BUY',
      label: 'Fib 61.8% 最後防線',
      description: `從 ${swingLow.price.toFixed(2)} 漲至 ${swingHigh.price.toFixed(2)} 後，回撤至 61.8% 水平 ${fib618.toFixed(2)}`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第4章＆第13章 — 費波納奇回撤',
        '原理：61.8% 是黃金比例，被認為是最重要的費波納奇回撤水平。',
        '回撤到此處通常是維持原趨勢的最後機會。',
        '如果跌破 61.8%，則原趨勢反轉的可能性大增（超過66%回撤 = 趨勢危險）。',
        '操作：在 61.8% 止跌時買入，但需設嚴格止損（跌破此位即出場）。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 費波納奇 1.618 倍延伸目標
 * Murphy 第13章（艾略特波浪）：突破後常見的價格延伸目標
 */
export const fib1618Extension: TradingRule = {
  id: 'murphy-fib-1618-ext',
  name: '費波納奇 1.618 倍延伸',
  description: '價格到達前一波段的 1.618 倍延伸目標，可能遇阻',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    // 找前一段下跌-反彈-再漲的結構
    const lows = findSwingLows(candles, index, 80, 3);
    const highs = findSwingHighs(candles, index, 80, 3);
    if (lows.length < 2 || highs.length < 1) return null;

    // 用第一段漲幅計算 1.618 倍延伸
    const low1 = lows[lows.length - 2]; // 第一波低點
    let high1: SwingPoint | null = null;
    for (const h of highs) {
      if (h.idx > low1.idx) { high1 = h; break; }
    }
    if (high1 == null) return null;

    const wave1Range = high1.price - low1.price;
    if (wave1Range <= 0) return null;

    // 找第一波高點之後的回撤低點
    let low2: SwingPoint | null = null;
    for (const l of lows) {
      if (l.idx > high1.idx) { low2 = l; break; }
    }
    if (low2 == null) return null;

    // 1.618 倍延伸目標 = 回撤低點 + 第一波 × 1.618
    const target = low2.price + wave1Range * 1.618;

    // 條件：當前價格到達目標附近（±2%）
    const tolerance = wave1Range * 0.02;
    if (c.high < target - tolerance || c.high > target + tolerance) return null;

    return {
      type: 'WATCH',
      label: 'Fib 1.618 倍目標',
      description: `第一波 ${low1.price.toFixed(2)}→${high1.price.toFixed(2)}，1.618 倍延伸目標 ${target.toFixed(2)}，當前 ${c.high.toFixed(2)}`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第13章 — 艾略特波浪理論',
        '原理：在艾略特波浪中，第三浪的長度經常是第一浪的 1.618 倍。',
        '1.618 是費波納奇數列中最重要的比例（黃金比例）。',
        '價格到達此目標時，短期至少會出現整理或回調。',
        '操作：在 1.618 倍延伸處應考慮部分獲利了結或收緊止損。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 三分之一/三分之二回撤區間
 * Murphy 第4章：最經典的回撤判斷法
 */
export const oneThirdTwoThirdZone: TradingRule = {
  id: 'murphy-one-third-two-third',
  name: '1/3-2/3 回撤區間',
  description: '價格回撤進入 33%-66% 的關鍵區間',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    const swing = findLastUpswing(candles, index);
    if (swing == null) return null;

    const { swingHigh, swingLow } = swing;
    const range = swingHigh.price - swingLow.price;
    if (range <= 0) return null;

    if (swingHigh.idx >= index - 3) return null;

    const retracement = (swingHigh.price - c.close) / range;

    // 條件：回撤剛進入 33% 水平（在 30%-36% 範圍內）
    if (retracement < 0.30 || retracement > 0.36) return null;

    // 條件：當日收盤接近止跌（非大跌）
    if (c.close < c.open && Math.abs(c.close - c.open) / c.open > 0.02) return null;

    const oneThird = swingHigh.price - range * 0.333;
    const twoThird = swingHigh.price - range * 0.666;

    return {
      type: 'WATCH',
      label: '進入 1/3 回撤區',
      description: `從 ${swingHigh.price.toFixed(2)} 回撤至 1/3 水平 ${oneThird.toFixed(2)}（2/3 支撐在 ${twoThird.toFixed(2)}）`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第4章 — 百分比回撤',
        '原理：Murphy 認為最重要的回撤區間是三分之一（33%）到三分之二（66%）。',
        '最小回撤約為前一趨勢的 33%，最大回撤約為 66%。',
        '50% 回撤是最常見的。超過 66% 回撤則趨勢可能已經反轉。',
        '操作：在 33% 回撤處開始關注，50% 處為主要買入區，66% 為最後防線。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── 匯出 ──────────────────────────────────────────────────────────────────────

export const MURPHY_RETRACEMENT_RULES: TradingRule[] = [
  fib382Support,
  fib618Support,
  fib1618Extension,
  oneThirdTwoThirdZone,
];
