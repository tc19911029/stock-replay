import { CandleWithIndicators } from '@/types';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TrendState = '多頭' | '空頭' | '盤整';

export type TrendPosition =
  | '起漲段'
  | '主升段'
  | '末升段(高檔)'
  | '起跌段'
  | '主跌段'
  | '末跌段(低檔)'
  | '盤整觀望';

export interface ConditionResult {
  pass: boolean;
  detail: string;
}

export interface SixConditionsResult {
  trend:     ConditionResult & { state: TrendState };
  position:  ConditionResult & { stage: TrendPosition };
  kbar:      ConditionResult & { type: string };
  ma:        ConditionResult & { alignment: string };
  volume:    ConditionResult & { ratio: number | null };
  indicator: ConditionResult & { macd: boolean; kd: boolean };
  totalScore: number; // 0–6
}

// ── Pivot detection ───────────────────────────────────────────────────────────

interface Pivot {
  index: number;
  price: number;
  type: 'high' | 'low';
}

/**
 * Find recent swing highs/lows using a simple 3-bar comparison.
 * Returns up to `maxPivots` pivots (newest first).
 */
function findPivots(
  candles: CandleWithIndicators[],
  endIndex: number,
  maxPivots = 10,
): Pivot[] {
  const pivots: Pivot[] = [];
  const lookback = Math.min(endIndex, 120);
  const start = endIndex - lookback;

  for (let i = endIndex - 1; i >= start + 1 && pivots.length < maxPivots; i--) {
    const prev  = candles[i - 1];
    const curr  = candles[i];
    const next  = candles[i + 1];

    if (curr.high > prev.high && curr.high > next.high) {
      pivots.push({ index: i, price: curr.high, type: 'high' });
    } else if (curr.low < prev.low && curr.low < next.low) {
      pivots.push({ index: i, price: curr.low, type: 'low' });
    }
  }
  return pivots;
}

// ── Trend detection ───────────────────────────────────────────────────────────

/**
 * Determine the overall trend by:
 * 1. First check MA alignment (fast method)
 * 2. Then validate with pivot structure (頭頭高底底高 vs 頭頭低底底低)
 */
export function detectTrend(
  candles: CandleWithIndicators[],
  index: number,
): TrendState {
  if (index < 20) return '盤整';
  const c = candles[index];

  // Quick MA-based filter
  const ma5  = c.ma5;
  const ma20 = c.ma20;
  const ma60 = c.ma60;

  if (ma5 == null || ma20 == null) return '盤整';

  // Strong bullish / bearish alignment
  const bullishMA = ma5 > ma20 && (ma60 == null || ma20 > ma60);
  const bearishMA = ma5 < ma20 && (ma60 == null || ma20 < ma60);

  if (!bullishMA && !bearishMA) return '盤整';

  // Confirm with pivot structure (需要至少 4 個轉折點)
  const pivots = findPivots(candles, index, 8);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 3);
  const lows  = pivots.filter(p => p.type === 'low').slice(0, 3);

  if (highs.length >= 2 && lows.length >= 2) {
    // 頭頭高底底高 → 多頭
    const higherHighs = highs[0].price > highs[1].price;
    const higherLows  = lows[0].price  > lows[1].price;
    // 頭頭低底底低 → 空頭
    const lowerHighs  = highs[0].price < highs[1].price;
    const lowerLows   = lows[0].price  < lows[1].price;

    if (higherHighs && higherLows && bullishMA) return '多頭';
    if (lowerHighs  && lowerLows  && bearishMA) return '空頭';
    return '盤整';
  }

  // Fallback: trust MA alignment alone
  if (bullishMA) return '多頭';
  if (bearishMA) return '空頭';
  return '盤整';
}

// ── Position / stage detection ────────────────────────────────────────────────

/**
 * Determine where price is within the current trend leg.
 * Uses % gain from the last confirmed low (for 多頭) or drop from last high (for 空頭).
 */
export function detectTrendPosition(
  candles: CandleWithIndicators[],
  index: number,
): TrendPosition {
  const trend = detectTrend(candles, index);
  if (trend === '盤整') return '盤整觀望';

  const lookback = Math.min(index, 200);
  const start = index - lookback;

  if (trend === '多頭') {
    // Find lowest low since the trend started (proxy: lowest close in lookback)
    let baseLow = Infinity;
    for (let i = start; i <= index; i++) {
      if (candles[i].low < baseLow) baseLow = candles[i].low;
    }
    const currentClose = candles[index].close;
    const gainPct = baseLow > 0 ? (currentClose - baseLow) / baseLow : 0;

    if (gainPct < 0.15)  return '起漲段';
    if (gainPct < 0.50)  return '主升段';
    return '末升段(高檔)';
  } else {
    // Find highest high since the downturn began
    let peakHigh = -Infinity;
    for (let i = start; i <= index; i++) {
      if (candles[i].high > peakHigh) peakHigh = candles[i].high;
    }
    const currentClose = candles[index].close;
    const dropPct = peakHigh > 0 ? (peakHigh - currentClose) / peakHigh : 0;

    if (dropPct < 0.15)  return '起跌段';
    if (dropPct < 0.50)  return '主跌段';
    return '末跌段(低檔)';
  }
}

// ── Six Conditions evaluator ──────────────────────────────────────────────────

/**
 * Evaluate 朱老師六大進場條件 for the candle at `index`.
 */
export function evaluateSixConditions(
  candles: CandleWithIndicators[],
  index: number,
): SixConditionsResult {
  const c = candles[index];

  // ① 趨勢
  const trendState = detectTrend(candles, index);
  const trendPass  = trendState === '多頭';
  const trendDetail = trendState === '多頭'
    ? '多頭趨勢（頭頭高底底高，MA5>MA20）'
    : trendState === '空頭'
    ? '空頭趨勢（頭頭低底底低）—— 不宜做多'
    : '盤整趨勢（方向不明）—— 觀望';

  // ② 位置
  const stage       = detectTrendPosition(candles, index);
  const positionPass = stage === '起漲段' || stage === '主升段';
  const positionDetail = (() => {
    const lookback = Math.min(index, 200);
    const start    = index - lookback;
    let baseLow = Infinity;
    for (let i = start; i <= index; i++) {
      if (candles[i].low < baseLow) baseLow = candles[i].low;
    }
    const gainPct = baseLow > 0
      ? ((c.close - baseLow) / baseLow * 100).toFixed(1)
      : '—';
    return `${stage}（距低點漲幅約 ${gainPct}%）`;
  })();

  // ③ K棒（長紅K：實體 > 2%，且收盤接近最高）
  const bodyPct  = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  const isRedK   = c.close > c.open;
  const isLongRed = isRedK && bodyPct >= 0.02;
  const kbarType  = isLongRed
    ? `長紅K（實體 ${(bodyPct * 100).toFixed(1)}%）`
    : isRedK
    ? `小紅K（實體 ${(bodyPct * 100).toFixed(1)}%，未達2%）`
    : `黑K（不符合進場條件）`;
  const kbarPass = isLongRed;

  // ④ 均線多頭排列 MA5 > MA10 > MA20
  const { ma5, ma10, ma20 } = c;
  const bullishAlign = ma5 != null && ma10 != null && ma20 != null
    && ma5 > ma10 && ma10 > ma20;
  const maAlignment = bullishAlign
    ? `MA5(${ma5?.toFixed(2)}) > MA10(${ma10?.toFixed(2)}) > MA20(${ma20?.toFixed(2)}) 多頭排列`
    : ma5 != null && ma10 != null && ma20 != null
    ? `MA5(${ma5.toFixed(2)}) / MA10(${ma10.toFixed(2)}) / MA20(${ma20.toFixed(2)}) 未達多排`
    : '均線資料不足';

  // ⑤ 量增（≥ 1.3x 5日均量）
  const volRatio = c.avgVol5 && c.avgVol5 > 0
    ? +(c.volume / c.avgVol5).toFixed(2)
    : null;
  const volumePass = volRatio != null && volRatio >= 1.3;
  const volumeDetail = volRatio != null
    ? `成交量是5日均量的 ${volRatio}x（${volumePass ? '量增' : '量縮/持平'}）`
    : '5日均量資料不足';

  // ⑥ 指標輔助（MACD 紅柱 + KD 多排）
  const macdBull = c.macdOSC != null && c.macdOSC > 0;
  const kdBull   = c.kdK != null && c.kdD != null && c.kdK > c.kdD && c.kdK > 50;
  const indicatorPass = macdBull || kdBull;
  const indicatorDetail = [
    macdBull ? `MACD紅柱(OSC=${c.macdOSC?.toFixed(3)})` : `MACD綠柱(OSC=${c.macdOSC?.toFixed(3) ?? '—'})`,
    kdBull   ? `KD多排(K=${c.kdK},D=${c.kdD})` : `KD未多排(K=${c.kdK ?? '—'},D=${c.kdD ?? '—'})`,
  ].join('；');

  const conditions = [trendPass, positionPass, kbarPass, bullishAlign, volumePass, indicatorPass];
  const totalScore = conditions.filter(Boolean).length;

  return {
    trend:     { pass: trendPass,     state: trendState, detail: trendDetail },
    position:  { pass: positionPass,  stage,             detail: positionDetail },
    kbar:      { pass: kbarPass,      type: kbarType,    detail: kbarType },
    ma:        { pass: bullishAlign,  alignment: maAlignment, detail: maAlignment },
    volume:    { pass: volumePass,    ratio: volRatio,   detail: volumeDetail },
    indicator: { pass: indicatorPass, macd: macdBull, kd: kdBull, detail: indicatorDetail },
    totalScore,
  };
}
