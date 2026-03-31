// ═══════════════════════════════════════════════════════════════
// Murphy《金融市場技術分析》第5-6章
// 補充型態規則 — 圓形底、V形反轉、關鍵反轉日、島形反轉、擴大形態
// （與現有 Edwards & Magee 規則不重複的部分）
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal } from '@/types';
import {
  findSwingHighs, findSwingLows, linearRegression,
  gapUp, gapDown, isVolumeBreakout,
} from './ruleUtils';

// ── 規則 ──────────────────────────────────────────────────────────────────────

/**
 * 圓形底（碗形底）
 * Murphy 第5章：緩慢漸進的底部反轉形態，成交量也呈碗形
 */
export const roundingBottom: TradingRule = {
  id: 'murphy-rounding-bottom',
  name: '圓形底（碗形底）',
  description: '價格形成圓弧形的底部結構，成交量隨之放大',
  evaluate(candles, index): RuleSignal | null {
    if (index < 40) return null;
    const c = candles[index];

    // 取近40根的收盤價做線性回歸和圓弧檢測
    const lookback = 40;
    const start = index - lookback + 1;

    // 找區間最低點
    let minIdx = start;
    let minPrice = Infinity;
    for (let i = start; i <= index; i++) {
      if (candles[i].close < minPrice) {
        minPrice = candles[i].close;
        minIdx = i;
      }
    }

    // 條件1：最低點在中間區域（不在邊緣）
    const minPos = (minIdx - start) / lookback;
    if (minPos < 0.25 || minPos > 0.75) return null;

    // 條件2：左側下降、右側上升（圓弧形狀）
    // 左半部回歸斜率 < 0
    const leftPoints = [];
    for (let i = start; i <= minIdx; i++) {
      leftPoints.push({ x: i, y: candles[i].close });
    }
    const leftReg = linearRegression(leftPoints);
    if (leftReg.slope >= 0) return null;

    // 右半部回歸斜率 > 0
    const rightPoints = [];
    for (let i = minIdx; i <= index; i++) {
      rightPoints.push({ x: i, y: candles[i].close });
    }
    const rightReg = linearRegression(rightPoints);
    if (rightReg.slope <= 0) return null;

    // 條件3：當前價格已回到起點附近或更高
    const startPrice = candles[start].close;
    if (c.close < startPrice * 0.95) return null;

    // 條件4：近5日成交量放大（碗形底的右半部量應增加）
    if (c.avgVol5 == null || c.avgVol20 == null) return null;
    if (c.avgVol5 < c.avgVol20 * 1.2) return null;

    return {
      type: 'BUY',
      label: '圓形底完成',
      description: `近${lookback}日形成碗形底部，最低 ${minPrice.toFixed(2)}，當前回升至 ${c.close.toFixed(2)}`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第5章 — 主要反轉形態',
        '原理：圓形底是一種漸進式的底部反轉形態，價格緩慢下跌、築底、再緩慢回升。',
        '成交量通常也呈碗形：在底部最低量，隨著價格回升而逐漸放大。',
        '圓形底完成後通常伴隨強勁的上升趨勢。',
        '操作：在價格回升超過碗形左側起點時確認突破，可以入場做多。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 關鍵反轉日（頂部）
 * Murphy 第5章：在上升趨勢中，創新高後反向收於前日收盤下方
 */
export const keyReversalDayTop: TradingRule = {
  id: 'murphy-key-reversal-top',
  name: '關鍵反轉日（頂部）',
  description: '上升趨勢中創新高後，收盤價反轉低於前日收盤',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 條件1：處於上升趨勢（MA20 上揚）
    if (c.ma20 == null || c.close < c.ma20) return null;
    const prevMa20 = candles[index - 5]?.ma20;
    if (prevMa20 == null || c.ma20 <= prevMa20) return null;

    // 條件2：當日創近期新高（近20根最高）
    let isNewHigh = true;
    for (let i = index - 20; i < index; i++) {
      if (i >= 0 && candles[i].high >= c.high) { isNewHigh = false; break; }
    }
    if (!isNewHigh) return null;

    // 條件3：收盤低於前日收盤
    if (c.close >= prev.close) return null;

    // 條件4：價格區間夠大（實體+影線）且成交量放大
    const dailyRange = (c.high - c.low) / c.low;
    if (dailyRange < 0.03) return null;
    if (!isVolumeBreakout(c, 1.5)) return null;

    return {
      type: 'SELL',
      label: '關鍵反轉日',
      description: `創新高 ${c.high.toFixed(2)} 後反轉收於 ${c.close.toFixed(2)}（低於前日 ${prev.close.toFixed(2)}），帶量`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第5章 — 主要反轉形態',
        '原理：關鍵反轉日在上升趨勢中出現，特徵是創出新高後反轉收低。',
        '價格區間越大、成交量越重，反轉信號越強烈。',
        '關鍵反轉日本身可能只標誌短期頂部，但有時也是主要頂部的開始。',
        '操作：出現關鍵反轉日後應立即收緊止損，等待進一步確認。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 關鍵反轉日（底部）
 * Murphy 第5章：在下降趨勢中，創新低後反向收於前日收盤上方
 */
export const keyReversalDayBottom: TradingRule = {
  id: 'murphy-key-reversal-bottom',
  name: '關鍵反轉日（底部）',
  description: '下降趨勢中創新低後，收盤價反轉高於前日收盤',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 條件1：處於下降趨勢（MA20 下彎）
    if (c.ma20 == null || c.close > c.ma20) return null;
    const prevMa20 = candles[index - 5]?.ma20;
    if (prevMa20 == null || c.ma20 >= prevMa20) return null;

    // 條件2：當日創近期新低
    let isNewLow = true;
    for (let i = index - 20; i < index; i++) {
      if (i >= 0 && candles[i].low <= c.low) { isNewLow = false; break; }
    }
    if (!isNewLow) return null;

    // 條件3：收盤高於前日收盤
    if (c.close <= prev.close) return null;

    // 條件4：帶量
    const dailyRange = (c.high - c.low) / c.low;
    if (dailyRange < 0.03) return null;
    if (!isVolumeBreakout(c, 1.5)) return null;

    return {
      type: 'WATCH',
      label: '底部關鍵反轉日',
      description: `創新低 ${c.low.toFixed(2)} 後反轉收於 ${c.close.toFixed(2)}（高於前日 ${prev.close.toFixed(2)}），帶量`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第5章 — 主要反轉形態',
        '原理：底部關鍵反轉日在下降趨勢中出現，創新低後強力反彈收高。',
        '這表示空方力竭、多方開始反擊。',
        '操作：底部關鍵反轉日為潛在底部信號，但需後續確認，不宜立即重倉。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 島形反轉（頂部）
 * Murphy 第5章：衰竭跳空後接突破跳空，孤立出一組K線形成「島嶼」
 */
export const islandReversalTop: TradingRule = {
  id: 'murphy-island-reversal-top',
  name: '島形反轉（頂部）',
  description: '向上跳空後幾天又向下跳空，形成頂部島形反轉',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 條件1：當日出現向下跳空
    if (!gapDown(prev, c)) return null;

    // 條件2：近 2-8 根之前曾出現向上跳空
    let upGapIdx = -1;
    for (let i = index - 2; i >= Math.max(1, index - 8); i--) {
      if (gapUp(candles[i - 1], candles[i])) {
        upGapIdx = i;
        break;
      }
    }
    if (upGapIdx < 0) return null;

    // 條件3：向上跳空的上緣 > 向下跳空的下緣（兩個缺口不重疊，形成真正的島嶼）
    const upGapUpper = candles[upGapIdx].low; // 向上跳空的下緣
    const downGapLower = c.high;              // 向下跳空的上緣
    // 「島嶼」的底部應高於兩個缺口
    if (downGapLower >= upGapUpper) return null; // 需要孤立

    return {
      type: 'SELL',
      label: '頂部島形反轉',
      description: `${index - upGapIdx}日前向上跳空→中間形成島嶼→今日向下跳空完成反轉`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第5章 — 主要反轉形態',
        '原理：島形反轉由兩個方向相反的跳空組成，中間孤立出一組K線（島嶼）。',
        '頂部島形反轉先有衰竭跳空（向上），幾天後出現突破跳空（向下）。',
        '島形反轉是非常強烈的反轉信號，在實戰中較為罕見但可靠。',
        '操作：出現島形反轉後應立即出場，信號非常可靠。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 擴大形態（頂部警告）
 * Murphy 第5章：波動逐漸放大的喇叭形頂部形態
 */
export const broadeningFormation: TradingRule = {
  id: 'murphy-broadening-top',
  name: '擴大形態（頂部）',
  description: '價格波動幅度逐漸擴大，高點越來越高、低點越來越低',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;

    // 找近40根的 swing highs 和 swing lows
    const highs = findSwingHighs(candles, index, 40, 2);
    const lows = findSwingLows(candles, index, 40, 2);

    if (highs.length < 3 || lows.length < 3) return null;

    const recentHighs = highs.slice(-3);
    const recentLows = lows.slice(-3);

    // 條件1：高點依次上升（頭頭高）
    if (!(recentHighs[1].price > recentHighs[0].price &&
          recentHighs[2].price > recentHighs[1].price)) return null;

    // 條件2：低點依次下降（底底低）
    if (!(recentLows[1].price < recentLows[0].price &&
          recentLows[2].price < recentLows[1].price)) return null;

    // 條件3：波動幅度在擴大
    const range1 = recentHighs[0].price - recentLows[0].price;
    const range2 = recentHighs[1].price - recentLows[1].price;
    const range3 = recentHighs[2].price - recentLows[2].price;
    if (!(range2 > range1 && range3 > range2)) return null;

    return {
      type: 'WATCH',
      label: '擴大形態警告',
      description: `價格波動逐漸擴大：高點上升(${recentHighs.map(h => h.price.toFixed(1)).join('→')})、低點下降(${recentLows.map(l => l.price.toFixed(1)).join('→')})`,
      reason: [
        '【出處】Murphy《金融市場技術分析》第5章 — 主要反轉形態',
        '原理：擴大形態（喇叭形）是一種罕見但重要的頂部形態。',
        '價格波動逐漸放大，反映市場情緒極度不穩定。',
        '擴大形態通常出現在主要牛市的末端，是市場失控的信號。',
        '操作：擴大形態難以交易，最安全的做法是在確認頂部後出場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── 匯出 ──────────────────────────────────────────────────────────────────────

export const MURPHY_PATTERN_RULES: TradingRule[] = [
  roundingBottom,
  keyReversalDayTop,
  keyReversalDayBottom,
  islandReversalTop,
  broadeningFormation,
];
