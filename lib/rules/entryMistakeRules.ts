// ═══════════════════════════════════════════════════════════════
// 朱家泓《活用技術分析寶典》第12篇
// 10大進場錯誤 — 負面篩選條件（觸發時為警告，不應進場）
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal } from '@/types';
import {
  bodyPct, maDeviation, isLongBlackCandle,
  isHighPosition, findSwingHigh,
} from './ruleUtils';

// ── 規則 ──────────────────────────────────────────────────────────────────────

/** 錯誤1：底部未突破月線就進場 */
export const mistakeBelowMA20: TradingRule = {
  id: 'zhu-mistake-below-ma20',
  name: '⚠進場錯誤：未突破月線',
  description: '股價在月線(MA20)之下就想做多，底部尚未確認',
  evaluate(candles, index): RuleSignal | null {
    if (index < 25) return null;
    const c = candles[index];
    if (c.ma20 == null) return null;

    // 股價在MA20之下 + 今日收紅K（散戶可能衝動買入）
    if (c.close >= c.ma20) return null;
    if (c.close <= c.open) return null;

    // MA20 仍在下彎
    const prevMa20 = candles[index - 3]?.ma20;
    if (prevMa20 == null || c.ma20 >= prevMa20) return null;

    return {
      type: 'WATCH',
      label: '⚠未過月線勿進場',
      description: `收盤${c.close.toFixed(1)}在MA20(${c.ma20.toFixed(1)})之下，月線仍下彎`,
      reason: [
        '【朱家泓《活用技術分析寶典》第12篇 10大進場錯誤①】',
        '底部未突破月線(MA20)就進場，是最常見的進場錯誤。',
        'MA20仍在下彎表示中期趨勢仍為空頭，不宜做多。',
        '應等股價站上MA20且MA20開始上揚後再考慮進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 錯誤2：上漲第3波後追高 */
export const mistakeChaseThirdWave: TradingRule = {
  id: 'zhu-mistake-chase-third-wave',
  name: '⚠進場錯誤：追第3波高',
  description: '多頭已上漲3波以上，此時追高風險極大',
  evaluate(candles, index): RuleSignal | null {
    if (index < 40) return null;
    const c = candles[index];
    if (c.ma5 == null) return null;

    // 偵測波段數：計算近期從MA5跌破到再站回的次數
    let waveCount = 0;
    let aboveMa5 = false;
    for (let i = Math.max(1, index - 60); i <= index; i++) {
      const ci = candles[i];
      if (ci.ma5 == null) continue;
      const nowAbove = ci.close > ci.ma5;
      if (!aboveMa5 && nowAbove) waveCount++;
      aboveMa5 = nowAbove;
    }

    if (waveCount < 3) return null;

    // 今日收紅K且在高檔
    if (c.close <= c.open) return null;
    if (!isHighPosition(c, candles, index)) return null;

    return {
      type: 'WATCH',
      label: '⚠勿追第3波',
      description: `已上漲${waveCount}波，高檔追高風險極大`,
      reason: [
        '【朱家泓《活用技術分析寶典》第12篇 10大進場錯誤②】',
        '上漲第3波後追高，是散戶最容易犯的追高錯誤。',
        '多頭通常在第3波末段開始出現做頭跡象。',
        '此時應觀望等待回檔，不宜追高進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 錯誤3：量價背離+KD高檔+乖離率大時進場 */
export const mistakeDivergenceHighKD: TradingRule = {
  id: 'zhu-mistake-divergence-high-kd',
  name: '⚠進場錯誤：量價背離+KD高檔',
  description: '股價創新高但量縮，且KD在高檔，乖離率過大',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];

    // 條件1：KD 高檔（K > 80）
    if (c.kdK == null || c.kdK < 80) return null;

    // 條件2：乖離率大（偏離MA20 > 10%）
    const dev = maDeviation(c, 'ma20');
    if (dev == null || dev < 0.10) return null;

    // 條件3：量縮（今日量 < 5日均量）
    if (c.avgVol5 == null || c.volume >= c.avgVol5) return null;

    // 條件4：價格在近期高點附近
    const swingHigh = findSwingHigh(candles, index, 20);
    if (swingHigh == null || c.close < swingHigh * 0.97) return null;

    return {
      type: 'WATCH',
      label: '⚠量價背離+KD高檔',
      description: `KD=${c.kdK.toFixed(0)}，乖離${(dev * 100).toFixed(1)}%，量縮至均量以下`,
      reason: [
        '【朱家泓《活用技術分析寶典》第12篇 10大進場錯誤③】',
        '量價背離（價高量縮）加上KD高檔超買，乖離率過大。',
        '三者同時出現是極危險的進場時機，隨時可能回檔。',
        '應耐心等待KD回到中性區且量能恢復後再進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 錯誤4：盤整區間內交易 */
export const mistakeTradingInRange: TradingRule = {
  id: 'zhu-mistake-trading-in-range',
  name: '⚠進場錯誤：盤整區內交易',
  description: '股價在盤整區間內，無明確方向不宜進場',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];
    if (c.bbBandwidth == null) return null;

    // 條件1：BB帶寬極窄（盤整）
    if (c.bbBandwidth > 0.08) return null;

    // 條件2：近10日高低點差距小（< 5%）
    let rangeHigh = -Infinity;
    let rangeLow = Infinity;
    for (let i = Math.max(0, index - 10); i <= index; i++) {
      rangeHigh = Math.max(rangeHigh, candles[i].high);
      rangeLow = Math.min(rangeLow, candles[i].low);
    }
    const rangePercent = (rangeHigh - rangeLow) / rangeLow;
    if (rangePercent > 0.05) return null;

    // 條件3：收盤在區間中間（不是突破也不是跌破）
    const mid = (rangeHigh + rangeLow) / 2;
    const distFromMid = Math.abs(c.close - mid) / (rangeHigh - rangeLow);
    if (distFromMid > 0.4) return null; // 接近邊緣可能是突破

    return {
      type: 'WATCH',
      label: '⚠盤整勿進場',
      description: `盤整區${rangeLow.toFixed(1)}~${rangeHigh.toFixed(1)}(${(rangePercent * 100).toFixed(1)}%)，BB帶寬${(c.bbBandwidth * 100).toFixed(1)}%`,
      reason: [
        '【朱家泓《活用技術分析寶典》第12篇 10大進場錯誤⑦】',
        '股價在盤整區間內，無明確方向。',
        '盤整中交易兩邊打巴掌，左右挨打。',
        '應等突破或跌破方向確認後再順勢進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 錯誤5：高檔爆量進場 */
export const mistakeHighVolumeTop: TradingRule = {
  id: 'zhu-mistake-high-volume-top',
  name: '⚠進場錯誤：爆量高點',
  description: '高檔出現異常大量，可能是主力出貨',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];

    // 條件1：在高檔
    if (!isHighPosition(c, candles, index)) return null;

    // 條件2：爆量（>= 5日均量 * 2.5 或 20日均量 * 3）
    const bigVol5 = c.avgVol5 != null && c.volume >= c.avgVol5 * 2.5;
    const bigVol20 = c.avgVol20 != null && c.volume >= c.avgVol20 * 3;
    if (!bigVol5 && !bigVol20) return null;

    // 條件3：出現上影線（賣壓）或收黑
    const upperShadow = c.high - Math.max(c.open, c.close);
    const bodySize = Math.abs(c.close - c.open);
    const hasUpperShadow = bodySize > 0 && upperShadow >= bodySize * 0.5;
    const isBlack = c.close < c.open;

    if (!hasUpperShadow && !isBlack) return null;

    const volRatio = c.avgVol5 != null
      ? (c.volume / c.avgVol5).toFixed(1)
      : (c.avgVol20 != null ? (c.volume / c.avgVol20).toFixed(1) : '?');

    return {
      type: 'WATCH',
      label: '⚠爆量高點勿進',
      description: `高檔爆量${volRatio}倍${isBlack ? '收黑' : '帶長上影'}，疑似主力出貨`,
      reason: [
        '【朱家泓《活用技術分析寶典》第12篇 10大進場錯誤⑨】',
        '高檔出現異常爆量，搭配上影線或收黑K，極可能是主力出貨。',
        '高檔爆量容易做頭，此時追高風險極大。',
        '應等回檔確認支撐後，若仍維持多頭架構再考慮進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 錯誤6：空頭反彈進場 */
export const mistakeBearBounce: TradingRule = {
  id: 'zhu-mistake-bear-bounce',
  name: '⚠進場錯誤：空頭反彈',
  description: '空頭趨勢中的反彈不宜做多，反彈是給你逃命的機會',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];
    if (c.ma20 == null || c.ma60 == null) return null;

    // 條件1：MA20 下彎（中期空頭）
    const prevMa20 = candles[index - 5]?.ma20;
    if (prevMa20 == null || c.ma20 >= prevMa20) return null;

    // 條件2：收盤在MA20之下
    if (c.close >= c.ma20) return null;

    // 條件3：收盤在MA60之下（長期空頭）
    if (c.close >= c.ma60) return null;

    // 條件4：今日收紅K上漲（散戶可能以為止跌了）
    if (c.close <= c.open) return null;
    if (bodyPct(c) < 0.015) return null;

    // 條件5：但仍在均線之下（只是反彈，不是反轉）
    return {
      type: 'WATCH',
      label: '⚠空頭反彈勿追',
      description: `MA20(${c.ma20.toFixed(1)})下彎，收盤${c.close.toFixed(1)}仍在均線下方`,
      reason: [
        '【朱家泓《活用技術分析寶典》第12篇 10大進場錯誤⑧】',
        '空頭趨勢中的反彈不宜做多。',
        'MA20仍在下彎且收盤在MA20/MA60之下，空頭趨勢未改變。',
        '空頭反彈是逃命的機會，不是進場的機會。',
        '應等趨勢反轉確認（突破MA20+MA20上揚）後再做多。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 錯誤7：價升長黑K時買進 */
export const mistakeBuyOnLongBlack: TradingRule = {
  id: 'zhu-mistake-buy-on-long-black',
  name: '⚠進場錯誤：漲後長黑K',
  description: '上漲途中出現長黑K線，多頭力道可能反轉',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];

    // 條件1：今日是長黑K
    if (!isLongBlackCandle(c)) return null;

    // 條件2：前面是上漲趨勢（近5日有3日收紅）
    let redCount = 0;
    for (let i = index - 5; i < index; i++) {
      if (i >= 0 && candles[i].close > candles[i].open) redCount++;
    }
    if (redCount < 3) return null;

    // 條件3：長黑K跌破5MA
    if (c.ma5 != null && c.close >= c.ma5) return null;

    return {
      type: 'WATCH',
      label: '⚠漲後長黑勿買',
      description: `上漲途中出現長黑K(${(bodyPct(c) * 100).toFixed(1)}%)跌破5MA`,
      reason: [
        '【朱家泓《活用技術分析寶典》第12篇 10大進場錯誤⑩】',
        '上漲途中出現長黑K線跌破5日均線，多頭力道可能反轉。',
        '此時不應進場做多，應觀察是否只是正常回檔。',
        '若後續跌破前低，趨勢將轉為盤整或空頭。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

export const ENTRY_MISTAKE_RULES: TradingRule[] = [
  mistakeBelowMA20,
  mistakeChaseThirdWave,
  mistakeDivergenceHighKD,
  mistakeTradingInRange,
  mistakeHighVolumeTop,
  mistakeBearBounce,
  mistakeBuyOnLongBlack,
];
