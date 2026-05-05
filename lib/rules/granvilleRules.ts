import { TradingRule, RuleSignal } from '@/types';
import { maDeviation } from './ruleUtils';

// ═══════════════════════════════════════════════════════════════
//  葛蘭碧八大法則 (Granville's 8 Rules)
//  以 MA20 為主要參考均線
// ═══════════════════════════════════════════════════════════════

// ── Helper ──────────────────────────────────────────────────────

/** 判斷 MA20 是否正在上升（近3根均線斜率為正） */
function isMaRising(candles: { ma20?: number }[], index: number): boolean {
  if (index < 3) return false;
  const c = candles[index].ma20;
  const p3 = candles[index - 3].ma20;
  if (c == null || p3 == null) return false;
  return c > p3;
}

/** 判斷 MA20 是否正在下降 */
function isMaFalling(candles: { ma20?: number }[], index: number): boolean {
  if (index < 3) return false;
  const c = candles[index].ma20;
  const p3 = candles[index - 3].ma20;
  if (c == null || p3 == null) return false;
  return c < p3;
}

/** 判斷 MA20 是否持平或轉折 */
function isMaFlattening(candles: { ma20?: number }[], index: number): boolean {
  if (index < 5) return false;
  const c = candles[index].ma20;
  const p5 = candles[index - 5].ma20;
  if (c == null || p5 == null) return false;
  return Math.abs(c - p5) / p5 < 0.005; // 變動率 < 0.5%
}

// ── 買入法則 1-4 ───────────────────────────────────────────────

/** 買入法則1: 均線由下降轉為水平或上升，價格由下向上突破均線 */
export const granvilleBuy1: TradingRule = {
  id: 'granville-buy-1',
  name: '葛蘭碧①：突破轉升均線',
  description: 'MA20由下降轉平或上升，價格由下往上突破MA20',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null || prev.ma20 == null) return null;

    const maFlat = isMaFlattening(candles, index) || isMaRising(candles, index);
    const priceCross = prev.close < prev.ma20! && c.close > c.ma20;

    if (!maFlat || !priceCross) return null;

    return {
      type: 'BUY',
      label: '葛蘭碧①買入',
      description: `價格由${prev.close}突破MA20(${c.ma20.toFixed(1)})，均線已轉平/上升`,
      reason: [
        '【葛蘭碧法則①】均線從下降轉為水平或上升時，價格由下向上穿越均線，是最經典的買入訊號。',
        '【原理】均線方向轉變代表趨勢可能反轉，價格突破確認了新趨勢的開始。',
        '【操作建議】搭配成交量放大確認。停損設在均線下方。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 買入法則2: 價格跌破上升中的均線後迅速反彈站回 */
export const granvilleBuy2: TradingRule = {
  id: 'granville-buy-2',
  name: '葛蘭碧②：跌破上升均線後站回',
  description: '價格跌破上升中的MA20後，迅速站回均線之上',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c = candles[index];
    if (c.ma20 == null) return null;
    if (!isMaRising(candles, index)) return null;

    // 前1-3根有跌破 MA20
    let hadBreakBelow = false;
    for (let i = index - 3; i < index; i++) {
      if (i >= 0 && candles[i].ma20 != null && candles[i].close < candles[i].ma20!) {
        hadBreakBelow = true;
        break;
      }
    }
    if (!hadBreakBelow) return null;

    // 當前站回 MA20 之上
    if (c.close <= c.ma20) return null;

    return {
      type: 'BUY',
      label: '葛蘭碧②買入',
      description: `價格跌破上升中MA20後迅速站回(${c.close} > MA20=${c.ma20.toFixed(1)})`,
      reason: [
        '【葛蘭碧法則②】價格短暫跌破上升中的均線後迅速站回，是「回測支撐成功」的訊號。',
        '【原理】上升中的均線有強支撐力，短暫跌破只是洗盤，快速站回代表多方仍然強勢。',
        '【操作建議】這是加碼好時機。若再次跌破且無法站回則停損。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 買入法則3: 價格在均線上方回跌但未跌破均線又上漲 */
export const granvilleBuy3: TradingRule = {
  id: 'granville-buy-3',
  name: '葛蘭碧③：均線上方回而不破',
  description: '上升趨勢中價格回跌靠近MA20但未跌破，再度上漲',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null || prev.ma20 == null) return null;
    if (!isMaRising(candles, index)) return null;

    // 近5根都在 MA20 之上
    let allAbove = true;
    for (let i = index - 4; i <= index; i++) {
      if (candles[i].ma20 == null || candles[i].close < candles[i].ma20!) {
        allAbove = false;
        break;
      }
    }
    if (!allAbove) return null;

    // 前幾根有回跌靠近（乖離率 < 2%）
    let hadApproach = false;
    for (let i = index - 3; i < index; i++) {
      const dev = maDeviation(candles[i], 'ma20');
      if (dev != null && dev < 0.02 && dev >= 0) {
        hadApproach = true;
        break;
      }
    }
    if (!hadApproach) return null;

    // 當前反彈（收盤 > 前一日收盤）
    if (c.close <= prev.close) return null;

    // 當前乖離率 > 2%（已拉開）
    const currentDev = maDeviation(c, 'ma20');
    if (currentDev == null || currentDev < 0.02) return null;

    return {
      type: 'BUY',
      label: '葛蘭碧③加碼',
      description: `上升趨勢中回測MA20(${c.ma20.toFixed(1)})未破，再度上漲至${c.close}`,
      reason: [
        '【葛蘭碧法則③】價格在上升的均線上方回跌但未跌破，再度上漲，是加碼買入的訊號。',
        '【原理】上升趨勢中的回調是健康的，回而不破代表趨勢依然完好。',
        '【操作建議】可加碼做多。停損設在 MA20 下方。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 買入法則4: 價格急跌遠離均線（乖離率過大） */
export const granvilleBuy4: TradingRule = {
  id: 'granville-buy-4',
  name: '葛蘭碧④：急跌遠離均線反彈',
  description: '價格急跌遠離MA20（乖離率超過-10%），短線反彈買入',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    if (c.ma20 == null) return null;

    const dev = maDeviation(c, 'ma20');
    if (dev == null || dev >= -0.10) return null; // 乖離率 < -10%

    // 需有止跌跡象（當日收紅或下影線 > 實體）
    const isRedCandle = c.close > c.open;
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    const body = Math.abs(c.close - c.open);
    const hasLongLowerShadow = body > 0 && lowerShadow > body;

    if (!isRedCandle && !hasLongLowerShadow) return null;

    return {
      type: 'WATCH',
      label: '葛蘭碧④反彈',
      description: `價格急跌遠離MA20，乖離率=${(dev * 100).toFixed(1)}%，出現止跌跡象`,
      reason: [
        '【葛蘭碧法則④】價格急跌遠離均線，乖離率過大，短線有均值回歸的反彈需求。',
        '【注意】這是短線反彈訊號，不是趨勢反轉。反彈目標通常是回到均線附近。',
        '【操作建議】輕倉試多，嚴設停損。到達均線附近即停利，不要貪心。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── 賣出法則 5-8 ───────────────────────────────────────────────

/** 賣出法則5: 均線由上升轉為水平或下降，價格由上向下跌破均線 */
export const granvilleSell5: TradingRule = {
  id: 'granville-sell-5',
  name: '葛蘭碧⑤：跌破轉平均線',
  description: 'MA20由上升轉平或下降，價格由上往下跌破MA20',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null || prev.ma20 == null) return null;

    const maFlatOrDown = isMaFlattening(candles, index) || isMaFalling(candles, index);
    const priceCross = prev.close > prev.ma20! && c.close < c.ma20;

    if (!maFlatOrDown || !priceCross) return null;

    return {
      type: 'SELL',
      label: '葛蘭碧⑤賣出',
      description: `價格由${prev.close}跌破MA20(${c.ma20.toFixed(1)})，均線已轉平/下降`,
      reason: [
        '【葛蘭碧法則⑤】均線從上升轉為水平或下降時，價格由上向下跌破均線，是賣出訊號。',
        '【原理】均線方向轉變 + 價格跌破，雙重確認趨勢反轉。',
        '【操作建議】持有者應停損出場。不宜搶反彈。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 賣出法則6: 價格突破下降中的均線後迅速回落 */
export const granvilleSell6: TradingRule = {
  id: 'granville-sell-6',
  name: '葛蘭碧⑥：假突破下降均線',
  description: '價格突破下降中的MA20後，無法站穩又跌回均線之下',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c = candles[index];
    if (c.ma20 == null) return null;
    if (!isMaFalling(candles, index)) return null;

    let hadBreakAbove = false;
    for (let i = index - 3; i < index; i++) {
      if (i >= 0 && candles[i].ma20 != null && candles[i].close > candles[i].ma20!) {
        hadBreakAbove = true;
        break;
      }
    }
    if (!hadBreakAbove) return null;

    if (c.close >= c.ma20) return null;

    return {
      type: 'SELL',
      label: '葛蘭碧⑥假突破',
      description: `價格曾突破下降中MA20但無法站穩，跌回${c.close} < MA20=${c.ma20.toFixed(1)}`,
      reason: [
        '【葛蘭碧法則⑥】價格突破下降中的均線後迅速回落，是「假突破」的賣出訊號。',
        '【原理】下降中的均線有壓制力，短暫突破只是反彈，無法站穩代表空方仍然主導。',
        '【操作建議】反彈出場的好時機。不要被假突破欺騙而追多。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 賣出法則7: 價格在均線下方反彈但未突破均線又下跌 */
export const granvilleSell7: TradingRule = {
  id: 'granville-sell-7',
  name: '葛蘭碧⑦：均線下方彈不過',
  description: '下降趨勢中價格反彈靠近MA20但未突破，再度下跌',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null || prev.ma20 == null) return null;
    if (!isMaFalling(candles, index)) return null;

    let allBelow = true;
    for (let i = index - 4; i <= index; i++) {
      if (candles[i].ma20 == null || candles[i].close > candles[i].ma20!) {
        allBelow = false;
        break;
      }
    }
    if (!allBelow) return null;

    // 前幾根有反彈靠近（負乖離率 > -2%）
    let hadApproach = false;
    for (let i = index - 3; i < index; i++) {
      const dev = maDeviation(candles[i], 'ma20');
      if (dev != null && dev > -0.02 && dev < 0) {
        hadApproach = true;
        break;
      }
    }
    if (!hadApproach) return null;

    if (c.close >= prev.close) return null;

    return {
      type: 'SELL',
      label: '葛蘭碧⑦加空',
      description: `下降趨勢中反彈靠近MA20(${c.ma20.toFixed(1)})未過，再度下跌至${c.close}`,
      reason: [
        '【葛蘭碧法則⑦】價格在下降的均線下方反彈但未突破，再度下跌，是加碼賣出的訊號。',
        '【原理】下降趨勢中的反彈是正常的，反彈不過代表空頭趨勢依然完好。',
        '【操作建議】不要抄底。等價格站回 MA20 之上再考慮做多。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 賣出法則8: 價格急漲遠離均線（乖離率過大） */
export const granvilleSell8: TradingRule = {
  id: 'granville-sell-8',
  name: '葛蘭碧⑧：急漲遠離均線停利',
  description: '價格急漲遠離MA20（乖離率超過+15%），短線停利',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    if (c.ma20 == null) return null;

    const dev = maDeviation(c, 'ma20');
    if (dev == null || dev <= 0.15) return null; // 乖離率 > +15%

    // 需有滯漲跡象（當日收黑或長上影線）
    const isBlackCandle = c.close < c.open;
    const upperShadow = c.high - Math.max(c.open, c.close);
    const body = Math.abs(c.close - c.open);
    const hasLongUpperShadow = body > 0 && upperShadow > body;

    if (!isBlackCandle && !hasLongUpperShadow) return null;

    return {
      type: 'REDUCE',
      label: '葛蘭碧⑧停利',
      description: `價格急漲遠離MA20，乖離率=+${(dev * 100).toFixed(1)}%，出現滯漲跡象`,
      reason: [
        '【葛蘭碧法則⑧】價格急漲遠離均線，乖離率過大，短線有均值回歸的回調壓力。',
        '【注意】這是短線獲利了結的訊號，不代表趨勢結束。回調目標通常是回到均線附近。',
        '【操作建議】分批停利鎖定獲利。等回調到均線附近再考慮是否重新進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

export const GRANVILLE_RULES: TradingRule[] = [
  granvilleBuy1, granvilleBuy2, granvilleBuy3, granvilleBuy4,
  granvilleSell5, granvilleSell6, granvilleSell7, granvilleSell8,
];
