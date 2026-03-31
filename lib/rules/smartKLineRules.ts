// ═══════════════════════════════════════════════════════════════
// 朱家泓《抓住線圖 股民變股神》
// 智慧K線戰法 + K線合併判斷 + 8個攻擊/下殺訊號
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal } from '@/types';
import { recentHigh } from '@/lib/indicators';
import {
  isLongRedCandle, isLongBlackCandle, halfPrice, bodyPct,
  hasLongUpperShadow, hasLongLowerShadow, isDoji,
  isInsideBar, mergedCandleDirection, trendSlope,
  isLowPosition, isHighPosition, bodySize,
} from './ruleUtils';

// ── 戰法1：智慧K線戰法 ──────────────────────────────────────────────────────

/** 智慧K線買進：收盤突破前一日最高點 */
export const smartKLineBuy: TradingRule = {
  id: 'smart-kline-buy',
  name: '智慧K線買進（收盤破前日最高）',
  description: '收盤價突破前一日K線最高點，趨勢斜率>45度時最佳',
  evaluate(candles, index): RuleSignal | null {
    if (index < 2) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.close <= prev.high) return null;

    const slope = trendSlope(candles, index, 10);
    const slopeStr = slope != null ? slope.toFixed(2) : 'N/A';
    const isStrong = slope != null && slope > 1.0;

    return {
      type: isStrong ? 'BUY' : 'WATCH',
      label: '智慧K線買進',
      description: `收盤 ${c.close.toFixed(2)} 突破前日最高 ${prev.high.toFixed(2)}，趨勢斜率 ${slopeStr}`,
      reason: [
        '【朱家泓《抓住線圖》第6章 智慧K線戰法】',
        '做多：收盤價突破前一日K線最高點時，買進。',
        '停損：以進場當日K線最低點為停損點。',
        isStrong
          ? '【趨勢斜率>45度】走勢強勁，適合使用此戰法，快速獲利機率高。'
          : '【趨勢斜率偏緩】走勢平緩時此方法容易頻繁停損，建議搭配其他戰法確認。',
        '【7項重點】必須遵守停損停利紀律；選走勢清楚的個股；走勢平緩（角度<45度）不建議用此法。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 智慧K線賣出：收盤跌破前一日最低點 */
export const smartKLineSell: TradingRule = {
  id: 'smart-kline-sell',
  name: '智慧K線賣出（收盤破前日最低）',
  description: '收盤價跌破前一日K線最低點，出場訊號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 2) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.close >= prev.low) return null;

    return {
      type: 'SELL',
      label: '智慧K線賣出',
      description: `收盤 ${c.close.toFixed(2)} 跌破前日最低 ${prev.low.toFixed(2)}`,
      reason: [
        '【朱家泓《抓住線圖》第6章 智慧K線戰法】',
        '做多出場：收盤確認股價跌破前一日最低點，出場。',
        '做空進場：收盤跌破前一日最低點時，也可做空。',
        '停損（做空）：以進場當日K線最高點為停損點。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── K線合併判斷 ──────────────────────────────────────────────────────────────

/** 子母K線型態（兩K線合併判斷） */
export const candleMergeSignal: TradingRule = {
  id: 'candle-merge-signal',
  name: '子母K線型態（K線合併）',
  description: '子母線出現（inside bar），合併兩日K線判斷多空力道',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (!isInsideBar(c, prev)) return null;

    const direction = mergedCandleDirection(prev, c);
    const dirLabel = direction === 'bullish' ? '偏多' : direction === 'bearish' ? '偏空' : '中性';

    return {
      type: 'WATCH',
      label: `子母線(${dirLabel})`,
      description: `今日K線完全在前日K線範圍內（子母線），合併判斷方向：${dirLabel}`,
      reason: [
        '【朱家泓《抓住線圖》第6章 K線合併判斷法】',
        '子母K線：當日K線（子線）完全在前日K線（母線）範圍內，表示盤整等待方向。',
        '合併看法：取第1天開盤、第2天收盤、兩天最高/最低合併成一條K線，判斷強弱。',
        direction === 'bullish'
          ? '長紅後小黑（大漲小回），多方力道強。'
          : direction === 'bearish'
            ? '長黑後小紅（大跌小漲），空方力道強。'
            : '方向不明確，等待突破。',
        '【操作】觀察次日是否突破母線高點（偏多）或跌破母線低點（偏空）。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── 低檔向上攻擊K線訊號 ──────────────────────────────────────────────────────

/** 低檔突破下降切線長紅K */
export const lowLongRedAttack: TradingRule = {
  id: 'low-long-red-attack',
  name: '低檔長紅突破（攻擊訊號①）',
  description: '低檔出現長紅K，收盤過前2日最高點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c = candles[index];
    if (!isLongRedCandle(c)) return null;
    if (!isLowPosition(c)) return null;
    const prevHigh = recentHigh(candles, index, 2);
    if (c.close <= prevHigh) return null;

    return {
      type: 'BUY',
      label: '低檔長紅攻擊',
      description: `低檔長紅K收盤 ${c.close.toFixed(2)} 過前2日高 ${prevHigh.toFixed(2)}`,
      reason: [
        '【朱家泓《抓住線圖》第7章 8個K線攻擊訊號 ①】',
        '低檔出現長紅K線，突破下降急切線，收盤過前2日最高點。',
        '這是多頭短線的強力表現，但需注意最低點的K線止跌訊號必須有過前2日最高點的確認紅K線出現。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 低檔鎚子線止跌 */
export const lowHammerAttack: TradingRule = {
  id: 'low-hammer-attack',
  name: '低檔鎚子線止跌（攻擊訊號②）',
  description: '低檔出現長下影線K線（鎚子），為止跌訊號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 2) return null;
    const c = candles[index];
    if (!isLowPosition(c)) return null;
    if (!hasLongLowerShadow(c)) return null;
    const bodyLen = bodySize(c);
    const shadowLen = Math.min(c.open, c.close) - c.low;
    if (bodyLen === 0 || shadowLen < bodyLen * 2) return null;

    return {
      type: 'WATCH',
      label: '低檔鎚子止跌',
      description: `低檔出現長下影線鎚子K線，下影長度為實體 ${(shadowLen / bodyLen).toFixed(1)} 倍`,
      reason: [
        '【朱家泓《抓住線圖》第7章 8個K線攻擊訊號 ②】',
        '低檔出現長下影線的鎚子線，是止跌訊號。',
        '第2日要紅K線，且過前一日最高點才能確認止跌反彈。',
        '【注意】單獨鎚子線只是止跌觀察，需次日確認。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 低檔十字線變盤 */
export const lowCrossAttack: TradingRule = {
  id: 'low-cross-attack',
  name: '低檔十字變盤（攻擊訊號③）',
  description: '低檔出現十字線或類似十字K線，為變盤訊號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 2) return null;
    const c = candles[index];
    if (!isLowPosition(c)) return null;
    if (!isDoji(c)) return null;

    return {
      type: 'WATCH',
      label: '低檔十字變盤',
      description: '低檔出現十字K線，可能變盤向上',
      reason: [
        '【朱家泓《抓住線圖》第7章 8個K線攻擊訊號 ③】',
        '低檔出現十字或類似十字K線，是變盤訊號。',
        '第2日突破前一日最高點的紅K線才能確認變盤。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 低檔陽包陰（吞噬） */
export const lowEngulfAttack: TradingRule = {
  id: 'low-engulf-attack',
  name: '低檔陽包陰吞噬（攻擊訊號⑥）',
  description: '低檔出現紅K吞噬前日黑K，破腳穿頭',
  evaluate(candles, index): RuleSignal | null {
    if (index < 2) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (!isLowPosition(c)) return null;
    if (!(prev.close < prev.open)) return null; // prev is black
    if (!(c.close > c.open)) return null; // curr is red
    // engulfing: curr body covers prev body
    if (!(c.close > prev.open && c.open < prev.close)) return null;

    return {
      type: 'BUY',
      label: '低檔陽包陰',
      description: `紅K吞噬前日黑K，收盤 ${c.close.toFixed(2)} 過前日開盤 ${prev.open.toFixed(2)}`,
      reason: [
        '【朱家泓《抓住線圖》第7章 8個K線攻擊訊號 ⑥】',
        '低檔出現長紅K線的「吞噬」現象，當日股價跌破前一日最低價，收盤過前一日最高點。',
        '為K線單日破腳穿頭現象，代表多頭強攻的態勢。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 低檔連三紅K */
export const lowThreeRedAttack: TradingRule = {
  id: 'low-three-red-attack',
  name: '低檔連三紅K（攻擊訊號⑧）',
  description: '低檔出現連續3根長紅K線',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c = candles[index];
    if (!isLowPosition(candles[index - 2])) return null;
    if (!isLongRedCandle(candles[index - 2])) return null;
    if (!isLongRedCandle(candles[index - 1])) return null;
    if (!isLongRedCandle(c)) return null;

    return {
      type: 'WATCH',
      label: '低檔連三紅',
      description: '低檔出現連續3根長紅K線，強勢多頭表現',
      reason: [
        '【朱家泓《抓住線圖》第7章 8個K線攻擊訊號 ⑧】',
        '低檔出現連續3根長紅K線，為強勢多頭表現，可以鎖股，等待回檔後的買進點。',
        '【注意】不宜追高，等回檔不破前低再上漲時進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── 高檔向下回檔K線訊號 ──────────────────────────────────────────────────────

/** 高檔射擊之星（長上影線） */
export const highShootingStar: TradingRule = {
  id: 'high-shooting-star',
  name: '高檔射擊之星（下殺訊號②）',
  description: '高檔出現長上影線K線，止漲訊號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 2) return null;
    const c = candles[index];
    if (!isHighPosition(c, candles, index)) return null;
    if (!hasLongUpperShadow(c)) return null;
    const bodyLen = bodySize(c);
    const shadowLen = c.high - Math.max(c.open, c.close);
    if (bodyLen === 0 || shadowLen < bodyLen * 2) return null;

    return {
      type: 'SELL',
      label: '高檔射擊之星',
      description: `高檔長上影線，上影為實體 ${(shadowLen / bodyLen).toFixed(1)} 倍`,
      reason: [
        '【朱家泓《抓住線圖》第7章 8個K線下殺訊號 ②】',
        '高檔出現長上影線的K線（射擊之星），是止漲訊號。',
        '第2天收盤跌破前一日最低點才能確認回檔。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高檔十字變盤 */
export const highCrossSell: TradingRule = {
  id: 'high-cross-sell',
  name: '高檔十字變盤（下殺訊號③）',
  description: '高檔出現十字K線，變盤訊號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 2) return null;
    const c = candles[index];
    if (!isHighPosition(c, candles, index)) return null;
    if (!isDoji(c)) return null;

    return {
      type: 'WATCH',
      label: '高檔十字變盤',
      description: '高檔出現十字K線，注意變盤風險',
      reason: [
        '【朱家泓《抓住線圖》第7章 8個K線下殺訊號 ③】',
        '高檔出現十字或類似十字K線，是變盤訊號。',
        '第2日跌破前一日最低點，才能確認變盤。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高檔陰包陽（吞噬） */
export const highEngulfSell: TradingRule = {
  id: 'high-engulf-sell',
  name: '高檔陰包陽吞噬（下殺訊號⑥）',
  description: '高檔出現黑K吞噬前日紅K，穿頭破腳',
  evaluate(candles, index): RuleSignal | null {
    if (index < 2) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (!isHighPosition(c, candles, index)) return null;
    if (!(prev.close > prev.open)) return null; // prev is red
    if (!(c.close < c.open)) return null; // curr is black
    // bearish engulfing: curr body covers prev body
    if (!(c.open > prev.close && c.close < prev.open)) return null;

    return {
      type: 'SELL',
      label: '高檔陰包陽',
      description: `黑K吞噬前日紅K，收盤 ${c.close.toFixed(2)} 破前日開盤 ${prev.open.toFixed(2)}`,
      reason: [
        '【朱家泓《抓住線圖》第7章 8個K線下殺訊號 ⑥】',
        '高檔出現長黑K線的「吞噬」現象，當日創新高、收盤跌破前一日最低點。',
        '為K線單日穿頭破腳，是空頭強勢表態。次日跌破長黑K線最低點，確認反轉。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高檔暮星（3K線組合） */
export const highEveningStar: TradingRule = {
  id: 'high-evening-star',
  name: '高檔暮星（下殺訊號）',
  description: '3K線組合：紅K→小十字→長黑K，高點轉折向下',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const k1 = candles[index - 2];
    const k2 = candles[index - 1];
    const k3 = candles[index];
    if (!isHighPosition(k1, candles, index - 2)) return null;
    // k1 is long red, k2 is small (doji-like), k3 is long black
    if (!isLongRedCandle(k1)) return null;
    if (bodyPct(k2) > 0.015) return null; // k2 should be small
    if (!isLongBlackCandle(k3)) return null;
    // k3 close should be below k1 midpoint
    if (k3.close > halfPrice(k1)) return null;

    return {
      type: 'SELL',
      label: '高檔暮星',
      description: '紅K→小K→長黑K 三日組合，高檔反轉訊號',
      reason: [
        '【朱家泓《抓住線圖》第6章 3條K線「夜星」變盤訊號】',
        '3條K線組合（暮星/夜星）：第1日長紅、第2日小K（十字線）、第3日長黑。',
        '合併為一條K線來看，就是高檔長上影線的變盤訊號。',
        '高點轉折向下的機率很高，持股者應考慮出場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};
