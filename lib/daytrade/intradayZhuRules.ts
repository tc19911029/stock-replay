/**
 * intradayZhuRules.ts — 朱老師 SOP 分時版規則
 * Phase 9：將日線 SOP 轉譯為分時 K 適用的當沖規則
 *
 * 轉譯原則：
 * - 六條件 SOP 在 5 分 K 上同樣適用（MA5=25 分鐘、MA20=100 分鐘）
 * - 量能基準：用 avgVol5（5 根均量）的 1.5 倍，取代日線的前日 1.3 倍
 * - 停損幅度：日 K 用 5% → 分時 K 用 0.5-1%（或 ATR × 1.5）
 * - 持有時間：當日收盤前必須平倉
 * - 大盤過濾：用 openRangeHigh/Low 替代月線
 *
 * 不適合平移的邏輯（已排除）：
 * - 週線/月線壓力判斷
 * - 長線 SOP 8 條
 * - 淘汰法部分條件
 * - 飆股守則
 */

import type {
  IntradayTradingRule,
  IntradaySignal,
  IntradayCandleWithIndicators,
  IntradayRuleContext,
} from './types';

let zhuCounter = 0;
function makeZhuSignal(
  rule: IntradayTradingRule,
  candle: IntradayCandleWithIndicators,
  ctx: IntradayRuleContext,
  overrides: Partial<IntradaySignal>,
): IntradaySignal {
  return {
    id: `zhu-${++zhuCounter}`,
    type: 'WATCH',
    ruleId: rule.id,
    label: rule.name,
    description: rule.description,
    reason: '',
    score: 50,
    triggeredAt: candle.time,
    timeframe: ctx.timeframe,
    price: candle.close,
    metadata: {},
    ...overrides,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRed(c: IntradayCandleWithIndicators): boolean { return c.close > c.open; }
function isBlack(c: IntradayCandleWithIndicators): boolean { return c.close < c.open; }
function bodyPct(c: IntradayCandleWithIndicators): number {
  return c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
}

function isTradableTime(time: string): boolean {
  const t = time.split('T')[1];
  if (!t) return true;
  const h = parseInt(t.slice(0, 2));
  const m = parseInt(t.slice(3, 5));
  const mins = h * 60 + m;
  if (mins < 9 * 60 + 15) return false;  // 跳過開盤前 15 分
  if (mins >= 13 * 60) return false;       // 1 點後不開新倉
  return true;
}

function isBullishMA(c: IntradayCandleWithIndicators): boolean {
  return c.ma5 != null && c.ma10 != null && c.ma20 != null
    && c.ma5 > c.ma10 && c.ma10 > c.ma20;
}

function isBearishMA(c: IntradayCandleWithIndicators): boolean {
  return c.ma5 != null && c.ma10 != null && c.ma20 != null
    && c.ma5 < c.ma10 && c.ma10 < c.ma20;
}

function aboveVWAP(c: IntradayCandleWithIndicators): boolean {
  return c.vwap != null && c.close > c.vwap;
}

function belowVWAP(c: IntradayCandleWithIndicators): boolean {
  return c.vwap != null && c.close < c.vwap;
}

function isHighVol(c: IntradayCandleWithIndicators, mult = 1.5): boolean {
  return c.avgVol5 != null && c.avgVol5 > 0 && c.volume >= c.avgVol5 * mult;
}

// ── 做多六條件分時版 BUY ────────────────────────────────────────────────────

/**
 * 朱老師六條件做多（分時版）
 * 條件1: 趨勢多頭（MA5>MA10>MA20 + 價格在 MA20 上方）
 * 條件2: 均線多排（MA5>MA10>MA20）
 * 條件3: 位置在均線上（close > MA20）
 * 條件4: 成交量放大（> avgVol5 × 1.5）
 * 條件5: 紅K實體棒（close > open, body > 0.3%）
 * 條件6: 指標輔助（MACD 紅柱 or KD 黃金交叉）
 * 前5條全過 + VWAP上方 → 進場
 */
const zhuSixConditionsBuy: IntradayTradingRule = {
  id: 'zhu-6cond-buy',
  name: '朱氏六條件做多',
  description: '分時版六條件SOP：趨勢+均線+位置+量+K線+指標',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 20) return null;
    const c = candles[idx];
    if (!isTradableTime(c.time)) return null;

    // 條件1+2: 趨勢多頭 + 均線多排
    if (!isBullishMA(c)) return null;

    // 條件3: 價格在 MA20 上方
    if (c.ma20 == null || c.close <= c.ma20) return null;

    // 條件4: 成交量放大
    if (!isHighVol(c, 1.5)) return null;

    // 條件5: 紅K實體棒
    if (!isRed(c) || bodyPct(c) < 0.003) return null;

    // VWAP 上方（分時版額外要求）
    if (!aboveVWAP(c)) return null;

    // 條件6: 指標輔助（加分但非必要）
    let indicatorBonus = 0;
    if (c.macdOSC != null && c.macdOSC > 0) indicatorBonus += 5;
    if (c.kdK != null && c.kdD != null && c.kdK > c.kdD && c.kdK < 80) indicatorBonus += 5;

    // 停損：ATR × 1.5 或 0.5% 取大者
    const atrStop = c.atr14 != null ? c.atr14 * 1.5 : c.close * 0.005;
    const stopLoss = c.close - Math.max(atrStop, c.close * 0.005);
    const target = c.close + (c.close - stopLoss) * 2;

    return makeZhuSignal(this, c, ctx, {
      type: 'BUY',
      score: 70 + indicatorBonus,
      reason: '六條件全過: 趨勢多+均線多排+位置佳+量能放大+紅K+VWAP上方',
      metadata: {
        entryPrice: c.close,
        stopLossPrice: stopLoss,
        targetPrice: target,
        riskRewardRatio: 2,
        confluenceFactors: ['六條件SOP', 'VWAP上方', '量能放大'],
      },
    });
  },
};

// ── 回踩均線買入（朱老師回檔到 MA 接住）────────────────────────────────────

const zhuMAPullbackBuy: IntradayTradingRule = {
  id: 'zhu-ma-pullback',
  name: '朱氏回踩均線',
  description: '多頭趨勢中回踩MA10/MA20後紅K反彈',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 20) return null;
    const c = candles[idx];
    const prev = candles[idx - 1];
    if (!isTradableTime(c.time)) return null;
    if (!prev) return null;

    // 多頭趨勢（MA20 向上）
    const prevMA20 = candles[idx - 5]?.ma20;
    if (c.ma20 == null || prevMA20 == null || c.ma20 <= prevMA20) return null;

    // 前一根觸及 MA10 或 MA20
    const touchedMA = prev.ma10 != null && prev.low <= prev.ma10 * 1.005
      || prev.ma20 != null && prev.low <= prev.ma20 * 1.005;
    if (!touchedMA) return null;

    // 當前紅K反彈
    if (!isRed(c) || bodyPct(c) < 0.003) return null;
    if (c.ma5 == null || c.close <= c.ma5) return null;

    // VWAP上方
    if (!aboveVWAP(c)) return null;

    const stopLoss = Math.min(prev.low, c.ma20 ?? c.low) * 0.998;
    const risk = c.close - stopLoss;
    const target = c.close + risk * 2;

    return makeZhuSignal(this, c, ctx, {
      type: 'BUY',
      score: 72,
      reason: '多頭趨勢回踩均線後紅K反彈，最佳進場位置',
      metadata: {
        entryPrice: c.close,
        stopLossPrice: stopLoss,
        targetPrice: target,
        riskRewardRatio: 2,
        confluenceFactors: ['回踩MA', 'MA20向上', 'VWAP上方'],
      },
    });
  },
};

// ── 頭頭高底底高趨勢確認買入 ────────────────────────────────────────────────

const zhuHigherHighBuy: IntradayTradingRule = {
  id: 'zhu-higher-high',
  name: '朱氏頭頭高突破',
  description: '底底高頭頭高確認後，突破前高買入',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 20) return null;
    const c = candles[idx];
    if (!isTradableTime(c.time)) return null;
    if (!isRed(c) || bodyPct(c) < 0.003) return null;
    if (!aboveVWAP(c)) return null;

    // 找前20根的兩個低點
    const lookback = candles.slice(Math.max(0, idx - 20), idx);
    const lows = lookback.map(x => x.low);
    const minLow = Math.min(...lows);
    // 前半和後半各找最低
    const half = Math.floor(lows.length / 2);
    const firstLow = Math.min(...lows.slice(0, half));
    const secondLow = Math.min(...lows.slice(half));

    // 底底高
    if (secondLow <= firstLow * 1.001) return null;

    // 突破前高
    const prevHigh = Math.max(...lookback.map(x => x.high));
    if (c.close <= prevHigh) return null;

    // 量能配合
    if (!isHighVol(c, 1.3)) return null;

    const stopLoss = secondLow * 0.998;
    const risk = c.close - stopLoss;

    return makeZhuSignal(this, c, ctx, {
      type: 'BUY',
      score: 75,
      reason: '底底高+頭頭高確認，突破前高，趨勢延續',
      metadata: {
        entryPrice: c.close,
        stopLossPrice: stopLoss,
        targetPrice: c.close + risk * 2.5,
        riskRewardRatio: 2.5,
        confluenceFactors: ['底底高', '突破前高', '量能配合'],
      },
    });
  },
};

// ── 做空六條件分時版 SELL ────────────────────────────────────────────────────

/**
 * 朱老師六條件做空（分時版）
 * 對稱版：空頭均線排列 + 價格在 MA20 下 + 量能 + 黑K + VWAP 下方
 */
const zhuSixConditionsSell: IntradayTradingRule = {
  id: 'zhu-6cond-sell',
  name: '朱氏六條件做空',
  description: '分時版六條件空頭SOP：趨勢空+均線空排+位置+量+黑K+指標',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 20) return null;
    const c = candles[idx];
    if (!isTradableTime(c.time)) return null;

    // 均線空排
    if (!isBearishMA(c)) return null;

    // 價格在 MA20 下方
    if (c.ma20 == null || c.close >= c.ma20) return null;

    // 量能放大
    if (!isHighVol(c, 1.5)) return null;

    // 黑K實體棒
    if (!isBlack(c) || bodyPct(c) < 0.003) return null;

    // VWAP 下方
    if (!belowVWAP(c)) return null;

    let indicatorBonus = 0;
    if (c.macdOSC != null && c.macdOSC < 0) indicatorBonus += 5;
    if (c.kdK != null && c.kdD != null && c.kdK < c.kdD && c.kdK > 20) indicatorBonus += 5;

    const atrStop = c.atr14 != null ? c.atr14 * 1.5 : c.close * 0.005;
    const stopLoss = c.close + Math.max(atrStop, c.close * 0.005);
    const target = c.close - (stopLoss - c.close) * 2;

    return makeZhuSignal(this, c, ctx, {
      type: 'SELL',
      score: 70 + indicatorBonus,
      reason: '空頭六條件全過: 趨勢空+均線空排+位置+量+黑K+VWAP下方',
      metadata: {
        entryPrice: c.close,
        stopLossPrice: stopLoss,
        targetPrice: target,
        riskRewardRatio: 2,
        confluenceFactors: ['六條件空頭SOP', 'VWAP下方', '量能放大'],
      },
    });
  },
};

// ── 頭頭低賣出（朱老師做空出場/趨勢轉弱信號）─────────────────────────────

const zhuLowerHighSell: IntradayTradingRule = {
  id: 'zhu-lower-high',
  name: '朱氏頭頭低轉空',
  description: '頭頭低確認趨勢轉弱，賣出/做空信號',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 20) return null;
    const c = candles[idx];
    if (!isTradableTime(c.time)) return null;
    if (!isBlack(c)) return null;

    const lookback = candles.slice(Math.max(0, idx - 20), idx);
    const highs = lookback.map(x => x.high);
    const half = Math.floor(highs.length / 2);
    const firstHigh = Math.max(...highs.slice(0, half));
    const secondHigh = Math.max(...highs.slice(half));

    // 頭頭低
    if (secondHigh >= firstHigh * 0.999) return null;

    // 跌破前低
    const prevLow = Math.min(...lookback.map(x => x.low));
    if (c.close >= prevLow) return null;

    // VWAP 下方
    if (!belowVWAP(c)) return null;

    return makeZhuSignal(this, c, ctx, {
      type: 'SELL',
      score: 68,
      reason: '頭頭低+跌破前低，趨勢轉弱',
      metadata: {
        entryPrice: c.close,
        stopLossPrice: secondHigh * 1.002,
        targetPrice: c.close - (secondHigh - c.close),
        riskRewardRatio: 1.5,
        confluenceFactors: ['頭頭低', '破前低', 'VWAP下方'],
      },
    });
  },
};

// ── 停損規則：進場 K 線最低點（分時版用 ATR）────────────────────────────────

const zhuStopLossAlert: IntradayTradingRule = {
  id: 'zhu-stop-loss',
  name: '朱氏停損警示',
  description: '跌破進場K線低點或ATR停損線，強制出場',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 5) return null;
    const c = candles[idx];

    // 急跌（單根跌幅超過 0.8%）
    const dropPct = (c.open - c.close) / c.open;
    if (dropPct < 0.008) return null;
    if (!isBlack(c)) return null;

    // 跌破 MA20
    if (c.ma20 == null || c.close >= c.ma20) return null;

    // 量能放大（恐慌性拋售）
    if (!isHighVol(c, 2.0)) return null;

    return makeZhuSignal(this, c, ctx, {
      type: 'STOP_LOSS',
      score: 90,
      reason: '急跌0.8%+破MA20+大量，觸發停損',
      metadata: {
        confluenceFactors: ['急跌', '破MA20', '大量恐慌'],
      },
    });
  },
};

// ── 獲利方程式分時版：漲幅>0.5% + 破 MA5 → 停利 ────────────────────────────

const zhuProfitTakeAlert: IntradayTradingRule = {
  id: 'zhu-profit-take',
  name: '朱氏獲利停利',
  description: '漲幅>0.5%後跌破MA5，建議停利',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 10) return null;
    const c = candles[idx];

    // 近期有上漲（從近 10 根低點到現在漲幅 > 0.5%）
    const recentLow = Math.min(...candles.slice(Math.max(0, idx - 10), idx).map(x => x.low));
    const gainFromLow = (c.high - recentLow) / recentLow;
    if (gainFromLow < 0.005) return null;

    // 黑K跌破MA5
    if (!isBlack(c)) return null;
    if (c.ma5 == null || c.close >= c.ma5) return null;

    // 但還在 MA20 上方（不是完全崩盤）
    if (c.ma20 == null || c.close < c.ma20) return null;

    return makeZhuSignal(this, c, ctx, {
      type: 'REDUCE',
      score: 65,
      reason: `漲幅${(gainFromLow * 100).toFixed(1)}%後跌破MA5，建議減碼停利`,
      metadata: {
        confluenceFactors: ['獲利方程式', '破MA5', '減碼信號'],
      },
    });
  },
};

// ── 大量不漲/不跌口訣（分時版）──────────────────────────────────────────────

const zhuVolumePriceMaxim: IntradayTradingRule = {
  id: 'zhu-vol-price-maxim',
  name: '朱氏量價口訣',
  description: '大量不漲要回檔 / 大量不跌要反彈',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 5) return null;
    const c = candles[idx];
    if (!isTradableTime(c.time)) return null;
    if (!isHighVol(c, 2.5)) return null;

    const changePct = (c.close - c.open) / c.open;

    // 大量不漲（高檔 + 漲跌幅 < 0.1%）→ 警示
    if (aboveVWAP(c) && Math.abs(changePct) < 0.001) {
      return makeZhuSignal(this, c, ctx, {
        type: 'RISK',
        score: 60,
        reason: '口訣: 多頭大量不漲，股價要回檔',
        metadata: { confluenceFactors: ['大量不漲', '量價背離'] },
      });
    }

    // 大量不跌（低檔 + 漲跌幅 > -0.1%）→ 觀察做多
    if (belowVWAP(c) && changePct > -0.001 && isRed(c)) {
      return makeZhuSignal(this, c, ctx, {
        type: 'WATCH',
        score: 55,
        reason: '口訣: 空頭大量不跌，股價要反彈',
        metadata: { confluenceFactors: ['大量不跌', '潛在反彈'] },
      });
    }

    return null;
  },
};

// ── 導出 ──────────────────────────────────────────────────────────────────────

export const zhuIntradayRules: IntradayTradingRule[] = [
  // 做多（3 條）
  zhuSixConditionsBuy,
  zhuMAPullbackBuy,
  zhuHigherHighBuy,
  // 做空（2 條）
  zhuSixConditionsSell,
  zhuLowerHighSell,
  // 風控（3 條）
  zhuStopLossAlert,
  zhuProfitTakeAlert,
  zhuVolumePriceMaxim,
];
