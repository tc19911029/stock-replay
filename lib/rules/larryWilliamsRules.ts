// ═══════════════════════════════════════════════════════════════
// Larry Williams《短線交易秘訣》原書第2版
// Long-Term Secrets to Short-Term Trading (2nd Edition)
//
// 核心策略：波動性突破 + 時間過濾 + Oops反轉 + 資金管理
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';
import { isMaTrendingUp, isMaTrendingDown } from './ruleUtils';

// ── 工具函數 ──────────────────────────────────────────────────────────────────

/** 計算 N 日平均真實波幅（ATR），若已有 atr14 且 N=14 則直接用 */
function calcATR(candles: CandleWithIndicators[], index: number, period: number): number | null {
  if (period === 14 && candles[index].atr14 != null) return candles[index].atr14!;
  if (index < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    sum += tr;
  }
  return sum / period;
}

/** 取得日期對應的周幾（1=周一, 5=周五），返回 0 表示無法判斷 */
function getDayOfWeek(dateStr: string): number {
  const d = new Date(dateStr);
  const dow = d.getDay(); // 0=Sun, 6=Sat
  return dow === 0 ? 7 : dow; // 轉為 1=Mon ~ 7=Sun
}

/** 收盤在當日區間中的位置 (0 = 最低, 1 = 最高) */
function closePosition(c: CandleWithIndicators): number {
  const range = c.high - c.low;
  if (range === 0) return 0.5;
  return (c.close - c.low) / range;
}

// ── 規則 1：波動性突破系統（VBO）★★★ ─────────────────────────────────────────

/**
 * 波動性突破買入（Volatility Breakout Buy）
 * 書中第4章核心系統：
 * 當日價格向上突破「開盤價 + 0.6 × ATR(3)」時買入，
 * 需配合20日均線向上（趨勢過濾）。
 */
export const volatilityBreakoutBuy: TradingRule = {
  id: 'lw-volatility-breakout-buy',
  name: '波動性突破買入（Larry Williams）',
  description: '開盤價+0.6×ATR(3)突破系統，配合MA20趨勢過濾',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];

    // 趨勢過濾：MA20 向上
    if (!isMaTrendingUp(candles, index, 'ma20', 5)) return null;

    // 計算 ATR(3)
    const atr3 = calcATR(candles, index - 1, 3);
    if (atr3 == null || atr3 === 0) return null;

    // 波動性突破觸發價 = 開盤價 + 0.6 × ATR(3)
    const triggerPrice = c.open + 0.6 * atr3;

    // 今日最高價觸及觸發價 → 突破成立
    if (c.high < triggerPrice) return null;

    // 收盤應在觸發價之上（確認突破有效）
    if (c.close < triggerPrice) return null;

    const breakPct = ((c.close - c.open) / c.open * 100).toFixed(1);

    return {
      type: 'BUY',
      label: '波動性突破',
      description: `收盤${c.close.toFixed(2)}突破觸發價${triggerPrice.toFixed(2)}（開盤+0.6×ATR3=${atr3.toFixed(2)}），漲幅${breakPct}%`,
      reason: 'Larry Williams核心系統：大區間日突破代表趨勢力量爆發，配合MA20上揚確認多頭環境。建議設固定止損（ATR的1.5~2倍）',
      ruleId: this.id,
    };
  },
};

/**
 * 波動性突破賣出（Volatility Breakout Sell）
 */
export const volatilityBreakoutSell: TradingRule = {
  id: 'lw-volatility-breakout-sell',
  name: '波動性突破賣出（Larry Williams）',
  description: '開盤價-0.6×ATR(3)跌破系統，配合MA20趨勢過濾',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];

    // 趨勢過濾：MA20 向下
    if (!isMaTrendingDown(candles, index, 'ma20', 5)) return null;

    const atr3 = calcATR(candles, index - 1, 3);
    if (atr3 == null || atr3 === 0) return null;

    const triggerPrice = c.open - 0.6 * atr3;

    if (c.low > triggerPrice) return null;
    if (c.close > triggerPrice) return null;

    const dropPct = ((c.open - c.close) / c.open * 100).toFixed(1);

    return {
      type: 'SELL',
      label: '波動性跌破',
      description: `收盤${c.close.toFixed(2)}跌破觸發價${triggerPrice.toFixed(2)}（開盤-0.6×ATR3），跌幅${dropPct}%`,
      reason: 'Williams波動性跌破：大幅向下突破代表空頭力量爆發。MA20下彎確認空頭環境，應立即出場',
      ruleId: this.id,
    };
  },
};

// ── 規則 2：Oops 反轉信號 ★★★ ──────────────────────────────────────────────

/**
 * Oops 買入信號（跳空低開反轉）
 * 書中第7章：市場跳空低開至前一日最低價以下，
 * 隨後反彈回升至前一日最低價以上，是強烈的反轉買入信號。
 * 歷史測試準確率約82%。
 */
export const oopsReversalBuy: TradingRule = {
  id: 'lw-oops-reversal-buy',
  name: 'Oops反轉買入（Larry Williams）',
  description: '跳空低開後回升至前日最低價以上 — 82%準確率的反轉信號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 條件1：今日開盤價 < 昨日最低價（跳空低開）
    if (c.open >= prev.low) return null;

    // 條件2：今日最高價 > 昨日最低價（回升穿越）
    if (c.high <= prev.low) return null;

    // 條件3：收盤 > 昨日最低價（確認回升有效）
    if (c.close <= prev.low) return null;

    const gapSize = ((prev.low - c.open) / prev.low * 100).toFixed(1);

    return {
      type: 'BUY',
      label: 'Oops反轉買入',
      description: `跳空低開${gapSize}%後回升穿越前日低點${prev.low.toFixed(2)}，收盤${c.close.toFixed(2)}`,
      reason: 'Williams Oops信號：跳空低開誘空後快速收復，代表賣壓衰竭、買方接手。歷史準確率82%，適合短線反彈操作',
      ruleId: this.id,
    };
  },
};

/**
 * Oops 賣出信號（跳空高開反轉）
 */
export const oopsReversalSell: TradingRule = {
  id: 'lw-oops-reversal-sell',
  name: 'Oops反轉賣出（Larry Williams）',
  description: '跳空高開後回落至前日最高價以下 — 強烈的反轉賣出信號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 條件1：今日開盤價 > 昨日最高價（跳空高開）
    if (c.open <= prev.high) return null;

    // 條件2：今日最低價 < 昨日最高價（回落穿越）
    if (c.low >= prev.high) return null;

    // 條件3：收盤 < 昨日最高價（確認回落有效）
    if (c.close >= prev.high) return null;

    const gapSize = ((c.open - prev.high) / prev.high * 100).toFixed(1);

    return {
      type: 'SELL',
      label: 'Oops反轉賣出',
      description: `跳空高開${gapSize}%後回落跌破前日高點${prev.high.toFixed(2)}，收盤${c.close.toFixed(2)}`,
      reason: 'Williams Oops賣出：跳空高開誘多後快速回落，代表買壓衰竭、賣方接手。建議立即減倉或出場',
      ruleId: this.id,
    };
  },
};

// ── 規則 3：TDW 周交易日過濾 ─────────────────────────────────────────────────

/**
 * TDW 最佳買入日（周一、周二）
 * 書中第4章/第6章：統計顯示標普500在周一和周二的表現最好，
 * 配合上漲趨勢 + 波動放大，構成最佳買入時機。
 */
export const tdwBestBuyDay: TradingRule = {
  id: 'lw-tdw-best-buy-day',
  name: 'TDW最佳買入日（Larry Williams）',
  description: '周一/周二 + 上漲趨勢 + 波動放大 = 統計最佳買點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    const dow = getDayOfWeek(c.date);

    // 只在周一(1)或周二(2)
    if (dow !== 1 && dow !== 2) return null;

    // 趨勢過濾：MA20 向上
    if (!isMaTrendingUp(candles, index, 'ma20', 5)) return null;

    // 波動放大：當日波幅 > ATR(14) 的 80%
    const atr = c.atr14;
    if (atr == null || atr === 0) return null;
    const todayRange = c.high - c.low;
    if (todayRange < atr * 0.8) return null;

    // 收紅
    if (c.close <= c.open) return null;

    const dayName = dow === 1 ? '周一' : '周二';

    return {
      type: 'WATCH',
      label: `TDW最佳日(${dayName})`,
      description: `${dayName}出現趨勢性上漲，波幅${(todayRange / atr * 100).toFixed(0)}%ATR，收盤${c.close.toFixed(2)}`,
      reason: 'Williams TDW統計：周一和周二是做多勝率最高的日子。配合上漲趨勢和波動放大，為短線買入增添信心',
      ruleId: this.id,
    };
  },
};

/**
 * TDW 最佳賣出日（周四、周五）
 */
export const tdwBestSellDay: TradingRule = {
  id: 'lw-tdw-best-sell-day',
  name: 'TDW最佳賣出日（Larry Williams）',
  description: '周四/周五 + 下跌趨勢 + 波動放大 = 統計最佳賣點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    const dow = getDayOfWeek(c.date);

    // 只在周四(4)或周五(5)
    if (dow !== 4 && dow !== 5) return null;

    // 趨勢過濾：MA20 向下
    if (!isMaTrendingDown(candles, index, 'ma20', 5)) return null;

    const atr = c.atr14;
    if (atr == null || atr === 0) return null;
    const todayRange = c.high - c.low;
    if (todayRange < atr * 0.8) return null;

    // 收黑
    if (c.close >= c.open) return null;

    const dayName = dow === 4 ? '周四' : '周五';

    return {
      type: 'WATCH',
      label: `TDW賣出日(${dayName})`,
      description: `${dayName}出現趨勢性下跌，波幅${(todayRange / atr * 100).toFixed(0)}%ATR，收盤${c.close.toFixed(2)}`,
      reason: 'Williams TDW統計：周四和周五是做空勝率最高的日子。配合下跌趨勢和波動放大，建議減倉或出場',
      ruleId: this.id,
    };
  },
};

// ── 規則 4：TDM 月交易日策略 ─────────────────────────────────────────────────

/**
 * 月末買入效應
 * 書中第10章：每月最後1-2個交易日買入，利用月初資金流入效應。
 */
export const tdmMonthEndBuy: TradingRule = {
  id: 'lw-tdm-month-end-buy',
  name: '月末買入效應（Larry Williams）',
  description: '月末最後2個交易日買入，利用月初資金流入效應',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5 || index >= candles.length - 1) return null;
    const c = candles[index];
    const next = candles[index + 1];

    // 判斷是否為月末：下一個交易日是不同月份
    const currMonth = c.date.slice(0, 7);
    const nextMonth = next.date.slice(0, 7);
    if (currMonth === nextMonth) {
      // 也檢查是否為倒數第2個交易日
      if (index >= candles.length - 2) return null;
      const nextNext = candles[index + 2];
      if (!nextNext || c.date.slice(0, 7) === nextNext.date.slice(0, 7)) return null;
    }

    // 基本過濾：不在暴跌中（收盤高於MA60）
    if (c.ma60 != null && c.close < c.ma60 * 0.9) return null;

    return {
      type: 'WATCH',
      label: '月末買入效應',
      description: `月末交易日${c.date}，收盤${c.close.toFixed(2)}。歷史統計月初1-4日有資金流入推升效應`,
      reason: 'Williams月末效應：機構月初調倉和資金流入創造短線上漲機會。適合在月末最後1-2天進場，持有到月初3-4天出場',
      ruleId: this.id,
    };
  },
};

// ── 規則 5：失敗振盪信號 ─────────────────────────────────────────────────────

/**
 * 失敗振盪買入（Smash Day Reversal Buy）
 * 書中第8章：最大振盪日收盤在低位後，次日反轉收高 = 買入信號。
 * 市場嘗試下跌但失敗，買方接手。
 */
export const smashDayReversalBuy: TradingRule = {
  id: 'lw-smash-day-reversal-buy',
  name: '失敗振盪買入（Larry Williams）',
  description: '大振盪日收盤低位後次日反轉收高 — 賣壓衰竭信號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    const atr = c.atr14;
    if (atr == null || atr === 0) return null;

    // 條件1：昨日是大振盪日（波幅 > 1.5 × ATR）
    const prevRange = prev.high - prev.low;
    if (prevRange < atr * 1.5) return null;

    // 條件2：昨日收盤在當日區間低位（< 30%）
    if (closePosition(prev) >= 0.3) return null;

    // 條件3：今日收盤反轉收在高位（> 60%）
    if (closePosition(c) <= 0.6) return null;

    // 條件4：今日收盤高於昨日收盤
    if (c.close <= prev.close) return null;

    return {
      type: 'BUY',
      label: '失敗振盪買入',
      description: `昨日大振盪(${(prevRange / atr * 100).toFixed(0)}%ATR)收低位，今日反轉收高位${c.close.toFixed(2)}`,
      reason: 'Williams失敗振盪：市場嘗試大幅下跌但失敗，次日買方接手反轉。這是短期底部的強烈信號，可配合止損進場',
      ruleId: this.id,
    };
  },
};

/**
 * 失敗振盪賣出（Smash Day Reversal Sell）
 */
export const smashDayReversalSell: TradingRule = {
  id: 'lw-smash-day-reversal-sell',
  name: '失敗振盪賣出（Larry Williams）',
  description: '大振盪日收盤高位後次日反轉收低 — 買壓衰竭信號',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    const atr = c.atr14;
    if (atr == null || atr === 0) return null;

    // 條件1：昨日是大振盪日
    const prevRange = prev.high - prev.low;
    if (prevRange < atr * 1.5) return null;

    // 條件2：昨日收盤在高位（> 70%）
    if (closePosition(prev) <= 0.7) return null;

    // 條件3：今日收盤反轉收在低位（< 40%）
    if (closePosition(c) >= 0.4) return null;

    // 條件4：今日收盤低於昨日收盤
    if (c.close >= prev.close) return null;

    return {
      type: 'SELL',
      label: '失敗振盪賣出',
      description: `昨日大振盪(${(prevRange / atr * 100).toFixed(0)}%ATR)收高位，今日反轉收低位${c.close.toFixed(2)}`,
      reason: 'Williams失敗振盪：市場嘗試大幅上漲但失敗，次日賣方接手反轉。這是短期頂部的強烈信號，建議減倉或出場',
      ruleId: this.id,
    };
  },
};

// ── 規則 6：大區間日趨勢信號 ─────────────────────────────────────────────────

/**
 * 大區間日買入（Range Expansion Buy）
 * 書中第1/3章：大區間日代表趨勢的真正驅動力。
 * 當日波幅超過 ATR 的 1.5 倍且收盤在高位，是強烈的趨勢確認。
 */
export const rangeExpansionBuy: TradingRule = {
  id: 'lw-range-expansion-buy',
  name: '大區間日多頭（Larry Williams）',
  description: '波幅>1.5倍ATR且收盤在高位 — 趨勢爆發確認',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];

    const atr = c.atr14;
    if (atr == null || atr === 0) return null;

    const range = c.high - c.low;

    // 大區間日：波幅 > 1.5 × ATR
    if (range < atr * 1.5) return null;

    // 收盤在當日區間上方（> 75%）
    if (closePosition(c) <= 0.75) return null;

    // 收紅
    if (c.close <= c.open) return null;

    // 趨勢確認：MA20 存在且向上
    if (!isMaTrendingUp(candles, index, 'ma20', 3)) return null;

    const rangePct = (range / atr * 100).toFixed(0);

    return {
      type: 'BUY',
      label: '大區間日多頭',
      description: `波幅${rangePct}%ATR，收盤在高位(${(closePosition(c) * 100).toFixed(0)}%)，收盤${c.close.toFixed(2)}`,
      reason: 'Williams大區間日理論：趨勢的真正力量來自大區間日。波幅顯著放大且收在高位，代表買方強勢主導，後續看漲',
      ruleId: this.id,
    };
  },
};

/**
 * 大區間日賣出（Range Expansion Sell）
 */
export const rangeExpansionSell: TradingRule = {
  id: 'lw-range-expansion-sell',
  name: '大區間日空頭（Larry Williams）',
  description: '波幅>1.5倍ATR且收盤在低位 — 空頭趨勢爆發',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];

    const atr = c.atr14;
    if (atr == null || atr === 0) return null;

    const range = c.high - c.low;
    if (range < atr * 1.5) return null;

    // 收盤在低位（< 25%）
    if (closePosition(c) >= 0.25) return null;

    // 收黑
    if (c.close >= c.open) return null;

    if (!isMaTrendingDown(candles, index, 'ma20', 3)) return null;

    const rangePct = (range / atr * 100).toFixed(0);

    return {
      type: 'SELL',
      label: '大區間日空頭',
      description: `波幅${rangePct}%ATR，收盤在低位(${(closePosition(c) * 100).toFixed(0)}%)，收盤${c.close.toFixed(2)}`,
      reason: 'Williams大區間日理論：大幅向下波動且收在低位，代表賣方強勢主導。空頭趨勢確認，應離場或做空',
      ruleId: this.id,
    };
  },
};

// ── 規則 7：三日均價突破（收盤偏離買入）──────────────────────────────────────

/**
 * 收盤價偏離突破買入
 * 書中第4章 §4.3：利用價格波動區分買賣雙方。
 * 當收盤價上漲達到過去三天平均真實波動的60%時買入。
 */
export const threeBarVolatilityBuy: TradingRule = {
  id: 'lw-3bar-volatility-buy',
  name: '三日波幅突破買入（Larry Williams）',
  description: '收盤價上漲達過去三天平均波幅60% — 波動率突破進場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];
    const prev = candles[index - 1];

    // 計算過去3天平均真實波幅
    const atr3 = calcATR(candles, index - 1, 3);
    if (atr3 == null || atr3 === 0) return null;

    // 收盤價相對昨日收盤的上漲幅度
    const priceMove = c.close - prev.close;

    // 上漲幅度 >= 60% × ATR(3)
    if (priceMove < 0.6 * atr3) return null;

    // 配合MA20趨勢向上
    if (c.ma20 == null || c.close < c.ma20) return null;

    return {
      type: 'WATCH',
      label: '三日波幅突破',
      description: `收盤上漲${(priceMove / atr3 * 100).toFixed(0)}%的ATR(3)，收盤${c.close.toFixed(2)}站上MA20`,
      reason: 'Williams波動率分析：收盤價漲幅達到短期波動幅度的60%以上，代表買方力量顯著超過常態波動，可關注後續走勢',
      ruleId: this.id,
    };
  },
};

// ── 匯出 ──────────────────────────────────────────────────────────────────────

export const LARRY_WILLIAMS_RULES: TradingRule[] = [
  // 波動性突破（核心系統）
  volatilityBreakoutBuy,
  volatilityBreakoutSell,
  // Oops 反轉
  oopsReversalBuy,
  oopsReversalSell,
  // TDW 周交易日
  tdwBestBuyDay,
  tdwBestSellDay,
  // TDM 月交易日
  tdmMonthEndBuy,
  // 失敗振盪
  smashDayReversalBuy,
  smashDayReversalSell,
  // 大區間日
  rangeExpansionBuy,
  rangeExpansionSell,
  // 三日波幅突破
  threeBarVolatilityBuy,
];
