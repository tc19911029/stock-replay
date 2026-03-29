/**
 * Retail Sentiment Proxy — 融資融券 & 散戶情緒代理指標
 *
 * Since real-time margin data isn't available via price APIs, we detect
 * retail sentiment through volume-price behavior patterns that strongly
 * correlate with margin trading activity:
 *
 * 1. Chase-buy detection: sharp volume spikes on gap-ups after extended moves
 *    → retail FOMO buying (often margin-fueled)
 * 2. Panic selling: volume spikes on large red candles near support
 *    → margin calls / forced liquidation
 * 3. Volume exhaustion: declining volume after parabolic rise
 *    → smart money distributing to late retail buyers
 * 4. Contrarian signal: extreme readings suggest reversal
 *
 * Research basis:
 * - 台股融資維持率 < 130% → 強制斷頭 → 暴量長黑 → 超跌反彈
 * - 融資大增 + 價創新高 → 散戶追高 → 主力出貨風險
 * - A股兩融餘額創新高 + RSI過熱 → 回檔壓力
 */

import { CandleWithIndicators } from '@/types';

export interface RetailSentimentResult {
  /** 0 = extreme panic (contrarian bullish), 100 = extreme euphoria (contrarian bearish) */
  sentimentScore: number;
  /** Contrarian signal: 'bullish' if retail panic, 'bearish' if retail euphoria, null if neutral */
  contrarianSignal: 'bullish' | 'bearish' | null;
  /** Penalty to apply to compositeScore (0 = no penalty, -20 = strong bearish contrarian) */
  compositeAdjust: number;
  flags: string[];
}

function clamp(v: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Detect retail FOMO chase-buying patterns.
 * High volume on gap-ups after already extended moves = late retail entry.
 */
function detectChaseBuying(candles: CandleWithIndicators[], idx: number): number {
  if (idx < 20) return 50;
  const c = candles[idx];
  const prev = candles[idx - 1];

  let score = 50; // neutral

  // Check: gap-up open with volume spike after 10+ day rally
  const isGapUp = c.open > prev.high;
  const volSpike = c.avgVol5 && c.avgVol5 > 0 ? c.volume / c.avgVol5 : 1;

  // Count recent up days (momentum already extended)
  let upDays = 0;
  for (let i = idx - 1; i >= Math.max(0, idx - 10); i--) {
    if (candles[i].close > candles[i - 1]?.close) upDays++;
  }

  // Extended rally + gap up + volume spike = FOMO chase-buying
  if (upDays >= 7 && isGapUp && volSpike > 2.0) {
    score = 90; // extreme FOMO
  } else if (upDays >= 5 && volSpike > 1.8) {
    score = 75;
  } else if (upDays >= 3 && volSpike > 1.5 && isGapUp) {
    score = 65;
  }

  return score;
}

/**
 * Detect panic selling / margin liquidation patterns.
 * Volume spike on large red candles near key support = forced selling.
 */
function detectPanicSelling(candles: CandleWithIndicators[], idx: number): number {
  if (idx < 20) return 50;
  const c = candles[idx];

  let score = 50; // neutral

  const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open * 100 : 0;
  const isBearish = c.close < c.open;
  const volSpike = c.avgVol5 && c.avgVol5 > 0 ? c.volume / c.avgVol5 : 1;

  // Count recent down days
  let downDays = 0;
  for (let i = idx - 1; i >= Math.max(0, idx - 10); i--) {
    if (candles[i].close < candles[i - 1]?.close) downDays++;
  }

  // Near MA60 support (potential margin call zone)
  const nearSupport = c.ma60 != null && c.low <= c.ma60 * 1.03;

  // Extended decline + big red candle + volume spike = panic / margin calls
  if (downDays >= 7 && isBearish && bodyPct > 4 && volSpike > 2.5) {
    score = 10; // extreme panic
  } else if (downDays >= 5 && isBearish && bodyPct > 3 && volSpike > 2.0) {
    score = 20;
  } else if (isBearish && nearSupport && volSpike > 2.0 && bodyPct > 2) {
    score = 25; // support breakdown panic
  }

  return score;
}

/**
 * Detect volume exhaustion after parabolic moves.
 * Volume declining while price makes new highs = distribution phase.
 */
function detectVolumeExhaustion(candles: CandleWithIndicators[], idx: number): number {
  if (idx < 20) return 50;

  // Check 10-day trend: is price making new highs?
  let priceNewHighs = 0;
  let volDeclining = 0;
  for (let i = idx - 9; i <= idx; i++) {
    if (i < 1) continue;
    if (candles[i].close > candles[i - 1].close) priceNewHighs++;
    if (candles[i].volume < candles[i - 1].volume) volDeclining++;
  }

  // Price rising but volume declining = distribution
  if (priceNewHighs >= 6 && volDeclining >= 6) return 80; // strong exhaustion signal
  if (priceNewHighs >= 5 && volDeclining >= 5) return 70;

  return 50;
}

/**
 * Main: compute retail sentiment proxy score
 */
export function computeRetailSentiment(
  candles: CandleWithIndicators[],
  idx: number,
): RetailSentimentResult {
  if (idx < 20) {
    return { sentimentScore: 50, contrarianSignal: null, compositeAdjust: 0, flags: [] };
  }

  const chase = detectChaseBuying(candles, idx);
  const panic = detectPanicSelling(candles, idx);
  const exhaustion = detectVolumeExhaustion(candles, idx);

  // Combine: panic pulls score down, chase/exhaustion push it up
  // sentimentScore: 0 = extreme fear, 100 = extreme greed
  const sentimentScore = clamp(Math.round(
    chase * 0.40 + (100 - panic) * 0.35 + exhaustion * 0.25
  ));

  const flags: string[] = [];
  let contrarianSignal: 'bullish' | 'bearish' | null = null;
  let compositeAdjust = 0;

  // Extreme euphoria (sentimentScore >= 80): retail chasing → bearish contrarian
  if (sentimentScore >= 85) {
    contrarianSignal = 'bearish';
    compositeAdjust = -15;
    flags.push('RETAIL_EUPHORIA');
    if (exhaustion >= 70) flags.push('VOLUME_EXHAUSTION');
    if (chase >= 80) flags.push('FOMO_CHASE');
  } else if (sentimentScore >= 75) {
    contrarianSignal = 'bearish';
    compositeAdjust = -8;
    flags.push('RETAIL_OVERHEATED');
  }
  // Extreme panic (sentimentScore <= 20): forced selling → bullish contrarian
  else if (sentimentScore <= 15) {
    contrarianSignal = 'bullish';
    compositeAdjust = 10;
    flags.push('PANIC_CAPITULATION');
  } else if (sentimentScore <= 25) {
    contrarianSignal = 'bullish';
    compositeAdjust = 5;
    flags.push('RETAIL_FEAR');
  }

  return { sentimentScore, contrarianSignal, compositeAdjust, flags };
}
