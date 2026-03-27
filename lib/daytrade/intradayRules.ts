/**
 * 當沖規則 v2 — 基於回測數據大幅優化
 *
 * v1 問題：
 * - VWAP 突破 0% 勝率 → 移除作為獨立買入規則
 * - 短均線金叉 9.7% 勝率 → 加入多重確認條件
 * - 出場太快（VWAP跌破43次/短均死叉28次）→ 提高賣出門檻
 * - 訊號太頻繁（日均 2.7 筆）→ 加嚴過濾
 *
 * v2 原則：
 * 1. 買入要嚴格：多重確認、量能配合、趨勢對齊
 * 2. 賣出要合理：不要一跌就賣，要看結構性轉弱
 * 3. 寧可錯過、不可做錯：降低交易頻率但提高品質
 */

import type {
  IntradayTradingRule,
  IntradaySignal,
  IntradayCandleWithIndicators,
  IntradayRuleContext,
} from './types';

let signalCounter = 0;
function makeSignal(
  rule: IntradayTradingRule,
  candle: IntradayCandleWithIndicators,
  ctx: IntradayRuleContext,
  overrides: Partial<IntradaySignal>,
): IntradaySignal {
  return {
    id: `sig-${++signalCounter}`,
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

// ── Helper: 計算近 N 根最高/最低 ────────────────────────────────────────────

function recentHigh(candles: IntradayCandleWithIndicators[], idx: number, n: number): number {
  let h = -Infinity;
  for (let i = Math.max(0, idx - n); i < idx; i++) h = Math.max(h, candles[i].high);
  return h;
}

function recentLow(candles: IntradayCandleWithIndicators[], idx: number, n: number): number {
  let l = Infinity;
  for (let i = Math.max(0, idx - n); i < idx; i++) l = Math.min(l, candles[i].low);
  return l;
}

function bodyRatio(c: IntradayCandleWithIndicators): number {
  const range = c.high - c.low;
  return range > 0 ? Math.abs(c.close - c.open) / range : 0;
}

function isRedCandle(c: IntradayCandleWithIndicators): boolean {
  return c.close > c.open;
}

/** 交易時間過濾：跳過開盤前15分鐘、收盤前10分鐘 */
function isTradableTime(time: string): boolean {
  const t = time.split('T')[1];
  if (!t) return true;
  const h = parseInt(t.slice(0, 2));
  const m = parseInt(t.slice(3, 5));
  const mins = h * 60 + m;
  // 台股 9:00~13:30 → 跳過開盤前15分 + 最後30分鐘（高風險區）
  if (mins < 9 * 60 + 15) return false;
  if (mins >= 13 * 60) return false;  // 1點後不再開新倉
  return true;
}

// ── 1. 強勢突破（爆量+新高+均線多排+VWAP上方）──────────────────────────────

const strongBreakout: IntradayTradingRule = {
  id: 'dt-strong-breakout',
  name: '強勢突破',
  description: '爆量創新高 + 均線多排 + VWAP上方 的高品質買點',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 15) return null;
    const curr = candles[idx];
    if (!isTradableTime(curr.time)) return null;
    if (!curr.avgVol5 || !curr.ma5 || !curr.ma10 || !curr.ma20 || !curr.vwap) return null;

    // 1. 量能放大 >= 2.5倍
    const volRatio = curr.volume / curr.avgVol5;
    if (volRatio < 2.5) return null;

    // 2. 紅K且實體飽滿（≥50%）
    if (!isRedCandle(curr)) return null;
    if (bodyRatio(curr) < 0.5) return null;

    // 3. 價格創近15根新高
    const prevHigh = recentHigh(candles, idx, 15);
    if (curr.high <= prevHigh) return null;

    // 4. 均線多排 MA5 > MA10 > MA20
    if (!(curr.ma5 > curr.ma10 && curr.ma10 > curr.ma20)) return null;

    // 5. 價格在 VWAP 上方 + 距VWAP不能太遠（防追高）
    if (curr.close <= curr.vwap) return null;
    if ((curr.close - curr.vwap) / curr.vwap > 0.012) return null; // 超過1.2%太高不追

    // 多週期共振加分
    const mtfBonus = ctx.mtfState?.overallBias === 'bullish' ? 10 : 0;

    // 6. ATR 止損止利（需要 ATR 數據）
    const atr = curr.atr14 ?? (curr.high - curr.low);
    const stopLoss = Math.min(curr.low, curr.vwap) - atr * 0.3;
    const target = curr.close + atr * 2;  // 風險報酬比 ≈ 2:1

    return makeSignal(this, curr, ctx, {
      type: 'BUY',
      reason: `爆量${volRatio.toFixed(1)}x 創新高 均線多排 VWAP上`,
      score: 80 + mtfBonus,
      metadata: {
        entryPrice: curr.close,
        stopLossPrice: stopLoss,
        targetPrice: target,
        confluenceFactors: ['爆量', '新高', '均線多排', 'VWAP上方'],
      },
    });
  },
};

// ── 2. 開盤區間突破（突破 + 量能確認 + 站穩）────────────────────────────────

const openRangeBreakConfirmed: IntradayTradingRule = {
  id: 'dt-open-range-confirmed',
  name: '開盤突破確認',
  description: '突破開盤區間高點，且站穩2根以上',
  applicableTimeframes: ['5m'],
  evaluate(candles, idx, ctx) {
    if (!ctx.openRangeHigh || !ctx.openRangeLow) return null;
    if (idx < 10) return null; // v3: 至少40分鐘後（原8→10）

    const curr = candles[idx];
    if (!isTradableTime(curr.time)) return null;

    const prev = candles[idx - 1];
    const prev2 = candles[idx - 2];
    const prev3 = candles[idx - 3];

    // 站穩3根（確認突破有效）
    if (!(prev3.close > ctx.openRangeHigh && prev2.close > ctx.openRangeHigh && prev.close > ctx.openRangeHigh && curr.close > ctx.openRangeHigh)) return null;

    // 當前根要是紅K
    if (!isRedCandle(curr)) return null;

    // v3: 量能放大 >= 1.5倍（原0.8→1.5）
    if (curr.avgVol5 && curr.volume < curr.avgVol5 * 1.5) return null;

    // VWAP 上方
    if (curr.vwap && curr.close <= curr.vwap) return null;

    // 確保之前沒有已觸發過（只觸發一次）
    const rangeSpread = ctx.openRangeHigh - ctx.openRangeLow;
    if (rangeSpread <= 0) return null;

    const stopLoss = ctx.openRangeHigh - rangeSpread * 0.3;
    const target = curr.close + rangeSpread * 1.5;  // 目標 = 1.5 倍區間

    return makeSignal(this, curr, ctx, {
      type: 'BUY',
      reason: `站穩開盤區間高點 ${ctx.openRangeHigh.toFixed(1)} 以上`,
      score: 75,
      metadata: {
        entryPrice: curr.close,
        stopLossPrice: stopLoss,
        targetPrice: target,
        confluenceFactors: ['開盤突破', '站穩確認'],
      },
    });
  },
};

// ── 3. 回踩均線不破再攻（最佳品質買點）─────────────────────────────────────

const pullbackBounce: IntradayTradingRule = {
  id: 'dt-pullback-bounce',
  name: '回踩反彈',
  description: '上漲趨勢中回踩MA10不破，再度轉強',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 20) return null;  // v3: 需要更多歷史數據
    const curr = candles[idx];
    if (!isTradableTime(curr.time)) return null;

    const prev = candles[idx - 1];
    if (!curr.ma5 || !curr.ma10 || !curr.ma20 || !prev.ma10) return null;

    // 1. 大趨勢向上：MA20 向上（近10根 MA20 遞增，v3從5→10更嚴）
    const ma20_10ago = candles[idx - 10]?.ma20;
    if (!ma20_10ago || curr.ma20! <= ma20_10ago) return null;

    // v3: MA5 > MA10 > MA20（均線多排）
    if (!(curr.ma5 > curr.ma10 && curr.ma10 > curr.ma20!)) return null;

    // 2. 前一根觸碰 MA10（低點 <= MA10 * 1.003，v3略放寬觸碰判定）
    if (prev.low > prev.ma10! * 1.003) return null;

    // 3. 當前根紅K反彈，收在 MA5 上方
    if (!isRedCandle(curr)) return null;
    if (curr.close <= curr.ma5!) return null;

    // 4. 實體飽滿（v3: ≥50%）
    if (bodyRatio(curr) < 0.5) return null;

    // 5. 量能不能太低
    if (curr.avgVol5 && curr.volume < curr.avgVol5 * 0.8) return null;

    // 6. VWAP 上方（強制要求）+ 距 VWAP 不超過1.5%
    if (!curr.vwap || curr.close <= curr.vwap) return null;
    if ((curr.close - curr.vwap) / curr.vwap > 0.015) return null;

    const aboveVwap = true;

    const atr = curr.atr14 ?? (curr.high - curr.low);
    const stopLoss = Math.min(prev.low * 0.998, curr.ma10! - atr * 0.5);
    const target = curr.close + atr * 1.5;

    return makeSignal(this, curr, ctx, {
      type: 'BUY',
      reason: `回踩MA10不破反彈${aboveVwap ? ' VWAP上方' : ''}`,
      score: aboveVwap ? 78 : 70,
      metadata: {
        entryPrice: curr.close,
        stopLossPrice: stopLoss,
        targetPrice: target,
        confluenceFactors: ['回踩不破', '趨勢向上', ...(aboveVwap ? ['VWAP上方'] : [])],
      },
    });
  },
};

// ── 4. 結構性轉弱（合理賣出，不是一跌就賣）──────────────────────────────────

const structuralWeakness: IntradayTradingRule = {
  id: 'dt-structural-weakness',
  name: '結構轉弱',
  description: '連續3根綠K + 跌破MA10 + 量能萎縮，結構性轉弱',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 5) return null;
    const curr = candles[idx];
    const prev = candles[idx - 1];
    const prev2 = candles[idx - 2];
    if (!curr.ma10) return null;

    // 1. 連續 3 根綠K（收<開）
    if (curr.close >= curr.open || prev.close >= prev.open || prev2.close >= prev2.open) return null;

    // 2. 跌破 MA10
    if (curr.close >= curr.ma10) return null;

    // 3. 近3根最低價跌破近10根支撐
    const support = recentLow(candles, idx - 3, 10);
    if (curr.low > support) return null;

    return makeSignal(this, curr, ctx, {
      type: 'SELL',
      reason: `連3綠K 跌破MA10 破近期支撐${support.toFixed(1)}`,
      score: 75,
      metadata: { confluenceFactors: ['連續綠K', '跌破均線', '破支撐'] },
    });
  },
};

// ── 5. VWAP 跌破（加嚴版：需量能配合+連續下跌）────────────────────────────

const vwapBreakdownConfirmed: IntradayTradingRule = {
  id: 'dt-vwap-breakdown',
  name: 'VWAP跌破確認',
  description: 'VWAP跌破 + 連2根收VWAP下方 + 量增',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 5) return null;  // v3: 需要更多數據
    const curr = candles[idx];
    const prev = candles[idx - 1];
    const prev2 = candles[idx - 2];
    if (!curr.vwap || !prev.vwap || !prev2.vwap) return null;

    // v3: 連3根收在 VWAP 下方（原2→3，大幅減少訊號數）
    if (!(prev2.close < prev2.vwap && prev.close < prev.vwap && curr.close < curr.vwap)) return null;

    // 當前根是綠K
    if (curr.close >= curr.open) return null;

    // v3: 跌幅要有意義（距VWAP超過0.5%，原0.3%→0.5%）
    const distPct = ((curr.vwap - curr.close) / curr.vwap) * 100;
    if (distPct < 0.5) return null;

    // v3: 量能萎縮才賣（反彈無量 = 真弱）
    if (curr.avgVol5 && curr.volume > curr.avgVol5 * 1.5) return null; // 放量不賣（可能是洗盤）

    return makeSignal(this, curr, ctx, {
      type: 'SELL',
      reason: `VWAP下方${distPct.toFixed(2)}% 連續走弱`,
      score: 68,
    });
  },
};

// ── 6. RSI 超買回落（賣出）────────────────────────────────────────────────

const rsiOverboughtDrop: IntradayTradingRule = {
  id: 'dt-rsi-overbought-drop',
  name: 'RSI超買回落',
  description: 'RSI從超買區回落，動能衰竭',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 3) return null;
    const prev = candles[idx - 1];
    const curr = candles[idx];
    if (prev.rsi14 == null || curr.rsi14 == null) return null;

    // 前一根在超買區(>75)，當前根跌出來
    if (!(prev.rsi14 > 75 && curr.rsi14 < 70)) return null;

    // 當前根是綠K
    if (curr.close >= curr.open) return null;

    return makeSignal(this, curr, ctx, {
      type: 'SELL',
      reason: `RSI 從 ${prev.rsi14.toFixed(0)} 回落至 ${curr.rsi14.toFixed(0)}，動能衰竭`,
      score: 65,
    });
  },
};

// ── 7. 量價背離（警示）─────────────────────────────────────────────────────

const volumePriceDivergence: IntradayTradingRule = {
  id: 'dt-vol-price-divergence',
  name: '量價背離',
  description: '價格創新高但量能遞減，上漲動能不足',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 10) return null;
    const curr = candles[idx];

    // 價格創近10根新高
    const prevHigh = recentHigh(candles, idx, 10);
    if (curr.high < prevHigh) return null;

    // 但量能遞減（近3根量比前3根低30%以上）
    const recentVol = (candles[idx].volume + candles[idx-1].volume + candles[idx-2].volume) / 3;
    const priorVol = (candles[idx-3].volume + candles[idx-4].volume + candles[idx-5].volume) / 3;
    if (priorVol <= 0 || recentVol >= priorVol * 0.7) return null;

    return makeSignal(this, curr, ctx, {
      type: 'RISK',
      reason: `價創新高但量縮${((1 - recentVol/priorVol) * 100).toFixed(0)}%，量價背離`,
      score: 60,
    });
  },
};

// ── 8. MACD 金叉+趨勢確認（買入）──────────────────────────────────────────

const macdBullishConfirmed: IntradayTradingRule = {
  id: 'dt-macd-bullish',
  name: 'MACD多方確認',
  description: 'MACD金叉 + 在零軸上方 + 價格在MA20上',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 10) return null;  // v3: 需更多數據
    const prev = candles[idx - 1];
    const curr = candles[idx];
    if (!isTradableTime(curr.time)) return null;
    if (ctx.mtfState?.overallBias === 'bearish') return null;  // v3: 偏空不買
    if (prev.macdOSC == null || curr.macdOSC == null || curr.macdDIF == null || !curr.ma20 || !curr.ma5 || !curr.ma10) return null;

    // v3: 均線多排
    if (!(curr.ma5 > curr.ma10 && curr.ma10 > curr.ma20)) return null;

    // MACD柱狀翻紅
    if (!(prev.macdOSC <= 0 && curr.macdOSC > 0)) return null;

    // DIF > 0（零軸上方）
    if (curr.macdDIF <= 0) return null;

    // 價格在 MA20 上方
    if (curr.close <= curr.ma20) return null;

    // 紅K
    if (!isRedCandle(curr)) return null;

    const atr = curr.atr14 ?? (curr.high - curr.low);
    return makeSignal(this, curr, ctx, {
      type: 'BUY',
      reason: `MACD翻紅(DIF ${curr.macdDIF.toFixed(2)}>0) 價在MA20上`,
      score: 72,
      metadata: {
        entryPrice: curr.close,
        stopLossPrice: curr.ma20 - atr * 0.3,
        targetPrice: curr.close + atr * 1.5,
        confluenceFactors: ['MACD金叉', '零軸上方', 'MA20上方'],
      },
    });
  },
};

// ── 9. 布林帶收縮突破（加嚴版）──────────────────────────────────────────────

const bollingerSqueeze: IntradayTradingRule = {
  id: 'dt-bollinger-squeeze',
  name: '布林收縮突破',
  description: '布林帶極度收縮後突破上軌 + 量能放大',
  applicableTimeframes: ['5m', '15m'],
  evaluate(candles, idx, ctx) {
    if (idx < 10) return null;
    const curr = candles[idx];
    if (curr.bbUpper == null || curr.bbBandwidth == null || !curr.avgVol5) return null;

    // 1. 帶寬要先收縮再擴張
    const bw5ago = candles[idx - 5]?.bbBandwidth;
    const bw3ago = candles[idx - 3]?.bbBandwidth;
    if (bw5ago == null || bw3ago == null) return null;

    // 3根前比5根前更窄（收縮）
    if (bw3ago > bw5ago) return null;
    // 現在比3根前寬（擴張）
    if (curr.bbBandwidth! <= bw3ago * 1.5) return null;

    // 2. 價格突破上軌
    if (curr.close <= curr.bbUpper!) return null;

    // 3. 紅K且量能放大
    if (!isRedCandle(curr)) return null;
    if (curr.volume < curr.avgVol5 * 1.5) return null;

    const bbMid = (curr.bbUpper! + (curr.bbLower ?? curr.bbUpper! * 0.98)) / 2;
    const target = curr.close + (curr.close - bbMid);  // 目標 = 等距上方
    return makeSignal(this, curr, ctx, {
      type: 'BUY',
      reason: `布林帶收縮後突破上軌 帶寬擴張 量增`,
      score: 76,
      metadata: {
        entryPrice: curr.close,
        stopLossPrice: bbMid,
        targetPrice: target,
        confluenceFactors: ['布林收縮突破', '量能放大'],
      },
    });
  },
};

// ── 10. 尾盤加速（下午1點後的動能延續）──────────────────────────────────────

const lateDayMomentum: IntradayTradingRule = {
  id: 'dt-late-day-momentum',
  name: '尾盤加速',
  description: '下午1點後量增價漲，尾盤搶進',
  applicableTimeframes: ['5m'],
  evaluate(candles, idx, ctx) {
    if (idx < 5) return null;
    const curr = candles[idx];

    // 只在下午1點後
    const hour = parseInt(curr.time.split('T')[1]?.split(':')[0] ?? '0');
    if (hour < 13) return null;

    // 紅K
    if (!isRedCandle(curr)) return null;

    // 量能放大
    if (!curr.avgVol5 || curr.volume < curr.avgVol5 * 2) return null;

    // 價格在日內高位（近期最高附近）
    const dayHigh = recentHigh(candles, idx, Math.min(idx, 60));
    if (curr.high < dayHigh * 0.998) return null;

    // MA5 > MA10（短期趨勢向上）
    if (!curr.ma5 || !curr.ma10 || curr.ma5 <= curr.ma10) return null;

    return makeSignal(this, curr, ctx, {
      type: 'BUY',
      reason: `尾盤加速 量增${(curr.volume / curr.avgVol5!).toFixed(1)}x 接近日高`,
      score: 70,
      metadata: {
        entryPrice: curr.close,
        confluenceFactors: ['尾盤', '量增', '日高附近'],
      },
    });
  },
};

// ── 收盤前強制平倉警告 ────────────────────────────────────────────────────────

const marketCloseWarning: IntradayTradingRule = {
  id: 'dt-market-close-warning',
  name: '收盤前平倉警告',
  description: '台股13:20後提醒：當沖部位需在13:30前平倉',
  applicableTimeframes: ['1m', '3m', '5m'],
  evaluate(candles, idx, ctx) {
    const curr = candles[idx];
    const t = curr.time.split('T')[1];
    if (!t) return null;
    const h = parseInt(t.slice(0, 2));
    const m = parseInt(t.slice(3, 5));
    const mins = h * 60 + m;

    // 13:20 ~ 13:30
    if (mins < 13 * 60 + 20 || mins > 13 * 60 + 30) return null;

    return makeSignal(this, curr, ctx, {
      type: 'RISK',
      reason: `距收盤剩 ${13 * 60 + 30 - mins} 分鐘，當沖部位應立即平倉`,
      score: 95,
      metadata: {
        confluenceFactors: ['收盤倒數', '強制平倉風險'],
      },
    });
  },
};

// ── 導出所有規則 ──────────────────────────────────────────────────────────────

export const defaultIntradayRules: IntradayTradingRule[] = [
  // 買入規則（4條，每條都需要多重確認）
  strongBreakout,
  openRangeBreakConfirmed,
  pullbackBounce,
  macdBullishConfirmed,
  bollingerSqueeze,
  lateDayMomentum,

  // 賣出規則（加嚴版，結構性轉弱才賣）
  structuralWeakness,
  vwapBreakdownConfirmed,
  rsiOverboughtDrop,

  // 警示（不觸發交易）
  volumePriceDivergence,
  marketCloseWarning,
];
