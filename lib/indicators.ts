import { Candle, CandleWithIndicators } from '@/types';

// ── EMA helper ────────────────────────────────────────────────────────────────
/**
 * Compute full EMA array for the closes array.
 * EMA[0] = closes[0]; EMA[i] = closes[i] * k + EMA[i-1] * (1-k)
 * where k = 2 / (period + 1)
 */
function computeEMA(closes: number[], period: number): (number | undefined)[] {
  const k = 2 / (period + 1);
  const result: (number | undefined)[] = new Array(closes.length).fill(undefined);
  // First valid EMA = SMA of first `period` values
  if (closes.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  result[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + (result[i - 1] as number) * (1 - k);
  }
  return result;
}

// ── MACD ──────────────────────────────────────────────────────────────────────
/**
 * Compute MACD arrays.
 * 標準參數: fast=12, slow=26, signal=9 (市場主流設定)
 */
function computeMACD(
  closes: number[],
  fast = 12, slow = 26, signalPeriod = 9
): { dif: (number | undefined)[]; signal: (number | undefined)[]; osc: (number | undefined)[] } {
  const emaFast   = computeEMA(closes, fast);
  const emaSlow   = computeEMA(closes, slow);

  // DIF = fast EMA - slow EMA
  const dif: (number | undefined)[] = closes.map((_, i) => {
    const f = emaFast[i], s = emaSlow[i];
    return f != null && s != null ? +(f - s).toFixed(4) : undefined;
  });

  // Signal = EMA of DIF values (only valid where DIF is defined)
  // Build a sub-array of valid DIF values, then map back
  const difValues = dif.filter((v): v is number => v != null);
  const kSignal = 2 / (signalPeriod + 1);
  const signalValues: number[] = [];
  let sum = 0;
  for (let i = 0; i < Math.min(signalPeriod, difValues.length); i++) sum += difValues[i];
  if (difValues.length >= signalPeriod) {
    signalValues[signalPeriod - 1] = sum / signalPeriod;
    for (let i = signalPeriod; i < difValues.length; i++) {
      signalValues[i] = difValues[i] * kSignal + signalValues[i - 1] * (1 - kSignal);
    }
  }

  // Map signal values back to original index positions
  const signal: (number | undefined)[] = new Array(closes.length).fill(undefined);
  const osc:    (number | undefined)[] = new Array(closes.length).fill(undefined);
  let validIdx = 0;
  for (let i = 0; i < closes.length; i++) {
    if (dif[i] != null) {
      if (signalValues[validIdx] != null) {
        signal[i] = +signalValues[validIdx].toFixed(4);
        osc[i]    = +(dif[i]! - signalValues[validIdx]).toFixed(4);
      }
      validIdx++;
    }
  }

  return { dif, signal, osc };
}

// ── KD Stochastic ─────────────────────────────────────────────────────────────
/**
 * Compute KD stochastic indicator.
 * 書中推薦參數: RSV period=9 (調整後5日一週版: period=5), k smoothing=3, d smoothing=3
 * We use the classic 9,3,3 (最常見設定).
 */
function computeKD(
  highs: number[], lows: number[], closes: number[],
  period = 9, kSmooth = 3, dSmooth = 3
): { k: (number | undefined)[]; d: (number | undefined)[] } {
  const kFactor = 1 / kSmooth;
  const dFactor = 1 / dSmooth;

  const kArr: (number | undefined)[] = new Array(closes.length).fill(undefined);
  const dArr: (number | undefined)[] = new Array(closes.length).fill(undefined);

  for (let i = period - 1; i < closes.length; i++) {
    // RSV = (close - lowest_low) / (highest_high - lowest_low) * 100
    let lowestLow  = Infinity;
    let highestHigh = -Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      lowestLow   = Math.min(lowestLow, lows[j]);
      highestHigh = Math.max(highestHigh, highs[j]);
    }
    const range = highestHigh - lowestLow;
    const rsv = range === 0 ? 50 : ((closes[i] - lowestLow) / range) * 100;

    // K = (1 - kFactor) * prevK + kFactor * RSV  (初值50)
    const prevK = i === period - 1 ? 50 : (kArr[i - 1] ?? 50);
    const prevD = i === period - 1 ? 50 : (dArr[i - 1] ?? 50);

    const k = (1 - kFactor) * prevK + kFactor * rsv;
    const d = (1 - dFactor) * prevD + dFactor * k;

    kArr[i] = +k.toFixed(2);
    dArr[i] = +d.toFixed(2);
  }

  return { k: kArr, d: dArr };
}

/**
 * Compute a simple moving average over a window of candle closes.
 * Returns undefined if there are not enough data points.
 */
function sma(closes: number[], end: number, period: number): number | undefined {
  if (end < period - 1) return undefined;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    sum += closes[i];
  }
  return +(sum / period).toFixed(3);
}

/**
 * Compute average volume over last `period` bars (including current).
 */
function avgVol(volumes: number[], end: number, period: number): number | undefined {
  if (end < period - 1) return undefined;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    sum += volumes[i];
  }
  return Math.round(sum / period);
}

/**
 * Enrich raw candles with MA5/10/20/60, avgVol5, MACD, and KD.
 * Computed once upfront on the full dataset.
 */
export function computeIndicators(candles: Candle[]): CandleWithIndicators[] {
  const closes  = candles.map((c) => c.close);
  const highs   = candles.map((c) => c.high);
  const lows    = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const macd = computeMACD(closes);
  const kd   = computeKD(highs, lows, closes);

  return candles.map((candle, i) => ({
    ...candle,
    ma5:     sma(closes, i, 5),
    ma10:    sma(closes, i, 10),
    ma20:    sma(closes, i, 20),
    ma60:    sma(closes, i, 60),
    avgVol5: avgVol(volumes, i, 5),
    macdDIF:    macd.dif[i],
    macdSignal: macd.signal[i],
    macdOSC:    macd.osc[i],
    kdK: kd.k[i],
    kdD: kd.d[i],
  }));
}

/**
 * Utility: check if price crossed above a moving average
 * (prev candle was below, current is above or equal)
 */
export function crossedAbove(
  candles: CandleWithIndicators[],
  index: number,
  maKey: 'ma5' | 'ma10' | 'ma20' | 'ma60'
): boolean {
  if (index < 1) return false;
  const prev = candles[index - 1];
  const curr = candles[index];
  const prevMA = prev[maKey];
  const currMA = curr[maKey];
  if (prevMA == null || currMA == null) return false;
  return prev.close < prevMA && curr.close >= currMA;
}

/**
 * Utility: check if price crossed below a moving average
 */
export function crossedBelow(
  candles: CandleWithIndicators[],
  index: number,
  maKey: 'ma5' | 'ma10' | 'ma20' | 'ma60'
): boolean {
  if (index < 1) return false;
  const prev = candles[index - 1];
  const curr = candles[index];
  const prevMA = prev[maKey];
  const currMA = curr[maKey];
  if (prevMA == null || currMA == null) return false;
  return prev.close > prevMA && curr.close <= currMA;
}

/**
 * Find the highest close/high within a lookback window (exclusive of current)
 */
export function recentHigh(
  candles: CandleWithIndicators[],
  index: number,
  lookback: number
): number {
  const start = Math.max(0, index - lookback);
  let high = -Infinity;
  for (let i = start; i < index; i++) {
    high = Math.max(high, candles[i].high);
  }
  return high;
}

/**
 * Find the lowest low within a lookback window (exclusive of current)
 */
export function recentLow(
  candles: CandleWithIndicators[],
  index: number,
  lookback: number
): number {
  const start = Math.max(0, index - lookback);
  let low = Infinity;
  for (let i = start; i < index; i++) {
    low = Math.min(low, candles[i].low);
  }
  return low;
}

/**
 * Check if all 3 short MAs are in bullish alignment: ma5 > ma10 > ma20
 */
export function isBullishMAAlignment(candle: CandleWithIndicators): boolean {
  const { ma5, ma10, ma20 } = candle;
  if (ma5 == null || ma10 == null || ma20 == null) return false;
  return ma5 > ma10 && ma10 > ma20;
}

/**
 * Check if all 3 short MAs are in bearish alignment: ma5 < ma10 < ma20
 */
export function isBearishMAAlignment(candle: CandleWithIndicators): boolean {
  const { ma5, ma10, ma20 } = candle;
  if (ma5 == null || ma10 == null || ma20 == null) return false;
  return ma5 < ma10 && ma10 < ma20;
}
