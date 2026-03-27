/**
 * 多週期共振分析器
 * 60m(40%) → 15m(25%) → 5m(20%) → 1m(15%)
 */

import type {
  IntradayCandle,
  IntradayCandleWithIndicators,
  IntradayTimeframe,
  TimeframeState,
  MultiTimeframeState,
} from './types';
import { aggregateCandles } from './IntradayDataAdapter';
import { computeIntradayIndicators } from './IntradayIndicators';

const TF_WEIGHTS: Record<string, number> = {
  '60m': 0.40, '15m': 0.25, '5m': 0.20, '1m': 0.15,
};

/** 分析單一週期的趨勢狀態 */
function assessTimeframe(
  candles: IntradayCandleWithIndicators[],
  tf: IntradayTimeframe,
): TimeframeState {
  if (candles.length < 3) {
    return {
      timeframe: tf, trend: 'neutral', trendStrength: 0,
      maAlignment: 'mixed', lastPrice: candles[candles.length - 1]?.close ?? 0,
      vwapRelation: 'at',
    };
  }

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // 均線排列
  let maAlignment: 'bullish' | 'bearish' | 'mixed' = 'mixed';
  if (last.ma5 != null && last.ma10 != null && last.ma20 != null) {
    if (last.ma5 > last.ma10 && last.ma10 > last.ma20) maAlignment = 'bullish';
    else if (last.ma5 < last.ma10 && last.ma10 < last.ma20) maAlignment = 'bearish';
  }

  // MACD 方向
  const macdBullish = last.macdOSC != null && last.macdOSC > 0;
  const macdBearish = last.macdOSC != null && last.macdOSC < 0;
  const macdRising  = last.macdOSC != null && prev.macdOSC != null && last.macdOSC > prev.macdOSC;

  // KD 狀態
  const kdBullish = last.kdK != null && last.kdD != null && last.kdK > last.kdD;

  // 價格 vs MA
  const aboveMA = last.ma20 != null && last.close > last.ma20;

  // 綜合趨勢判斷
  let bullPoints = 0, bearPoints = 0;
  if (maAlignment === 'bullish') bullPoints += 3; else if (maAlignment === 'bearish') bearPoints += 3;
  if (macdBullish) bullPoints += 2; else if (macdBearish) bearPoints += 2;
  if (macdRising) bullPoints += 1; else bearPoints += 1;
  if (kdBullish) bullPoints += 1; else bearPoints += 1;
  if (aboveMA) bullPoints += 2; else bearPoints += 2;

  const total = bullPoints + bearPoints || 1;
  let trend: 'bullish' | 'bearish' | 'neutral';
  let trendStrength: number;

  if (bullPoints > bearPoints * 1.5) {
    trend = 'bullish';
    trendStrength = Math.min(100, (bullPoints / total) * 100);
  } else if (bearPoints > bullPoints * 1.5) {
    trend = 'bearish';
    trendStrength = Math.min(100, (bearPoints / total) * 100);
  } else {
    trend = 'neutral';
    trendStrength = 30;
  }

  // VWAP 關係
  let vwapRelation: 'above' | 'below' | 'at' = 'at';
  if (last.vwap != null) {
    const diff = (last.close - last.vwap) / last.vwap;
    if (diff > 0.001) vwapRelation = 'above';
    else if (diff < -0.001) vwapRelation = 'below';
  }

  return {
    timeframe: tf,
    trend,
    trendStrength: Math.round(trendStrength),
    maAlignment,
    lastPrice: last.close,
    vwapRelation,
  };
}

/**
 * 多週期共振分析
 * 輸入 1m K 線，自動聚合為 5m/15m/60m 並分析
 */
export function analyzeMultiTimeframe(
  minuteCandles: IntradayCandle[],
): MultiTimeframeState {
  const timeframes: IntradayTimeframe[] = ['1m', '5m', '15m', '60m'];
  const states = {} as Record<IntradayTimeframe, TimeframeState>;

  for (const tf of timeframes) {
    const agg = aggregateCandles(minuteCandles, tf);
    const withInd = computeIntradayIndicators(agg);
    states[tf] = assessTimeframe(withInd, tf);
  }

  // 計算共振分數
  let weightedBull = 0, weightedBear = 0;
  for (const tf of timeframes) {
    const s = states[tf];
    const w = TF_WEIGHTS[tf];
    if (s.trend === 'bullish') weightedBull += w * s.trendStrength;
    else if (s.trend === 'bearish') weightedBear += w * s.trendStrength;
  }

  const totalWeight = Object.values(TF_WEIGHTS).reduce((a, b) => a + b, 0);
  const bullScore = weightedBull / totalWeight;
  const bearScore = weightedBear / totalWeight;

  let overallBias: 'bullish' | 'bearish' | 'neutral';
  let confluenceScore: number;

  if (bullScore > bearScore * 1.3) {
    overallBias = 'bullish';
    confluenceScore = Math.round(bullScore);
  } else if (bearScore > bullScore * 1.3) {
    overallBias = 'bearish';
    confluenceScore = Math.round(bearScore);
  } else {
    overallBias = 'neutral';
    confluenceScore = Math.round(Math.max(bullScore, bearScore) * 0.5);
  }

  // 生成描述
  const tfDescriptions = timeframes.map(tf => {
    const s = states[tf];
    const icon = s.trend === 'bullish' ? '🟢' : s.trend === 'bearish' ? '🔴' : '🟡';
    return `${tf}${icon}`;
  });

  const biasLabel = overallBias === 'bullish' ? '偏多' : overallBias === 'bearish' ? '偏空' : '中性';
  const description = `${tfDescriptions.join(' ')} → ${biasLabel}(${confluenceScore})`;

  return { timeframes: states, overallBias, confluenceScore, description };
}
