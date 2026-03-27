/**
 * 分鐘級指標計算
 * 複用 lib/indicators.ts 的核心計算，新增 VWAP
 */

import type { IntradayCandle, IntradayCandleWithIndicators } from './types';

// ── SMA ───────────────────────────────────────────────────────────────────────

function sma(values: number[], period: number): (number | undefined)[] {
  const result: (number | undefined)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { result.push(undefined); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    result.push(sum / period);
  }
  return result;
}

// ── EMA ───────────────────────────────────────────────────────────────────────

function ema(values: number[], period: number): (number | undefined)[] {
  const result: (number | undefined)[] = [];
  const k = 2 / (period + 1);
  let prev: number | undefined;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { result.push(undefined); continue; }
    if (prev === undefined) {
      let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    result.push(prev);
  }
  return result;
}

// ── MACD ──────────────────────────────────────────────────────────────────────

function macd(closes: number[]) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif: (number | undefined)[] = [];
  for (let i = 0; i < closes.length; i++) {
    dif.push(ema12[i] != null && ema26[i] != null ? ema12[i]! - ema26[i]! : undefined);
  }
  const validDif = dif.filter(v => v != null) as number[];
  const signal = ema(validDif, 9);
  // Align signal back
  const signalFull: (number | undefined)[] = new Array(dif.length).fill(undefined);
  let si = 0;
  for (let i = 0; i < dif.length; i++) {
    if (dif[i] != null) { signalFull[i] = signal[si++]; }
  }
  const osc: (number | undefined)[] = dif.map((d, i) =>
    d != null && signalFull[i] != null ? d - signalFull[i]! : undefined
  );
  return { dif, signal: signalFull, osc };
}

// ── KD ────────────────────────────────────────────────────────────────────────

function kd(highs: number[], lows: number[], closes: number[], period = 9) {
  const ks: (number | undefined)[] = [];
  const ds: (number | undefined)[] = [];
  let prevK = 50, prevD = 50;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { ks.push(undefined); ds.push(undefined); continue; }
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) { hh = Math.max(hh, highs[j]); ll = Math.min(ll, lows[j]); }
    const rsv = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
    const k = prevK * 2 / 3 + rsv / 3;
    const d = prevD * 2 / 3 + k / 3;
    prevK = k; prevD = d;
    ks.push(k); ds.push(d);
  }
  return { k: ks, d: ds };
}

// ── RSI ───────────────────────────────────────────────────────────────────────

function rsi(closes: number[], period = 14): (number | undefined)[] {
  const result: (number | undefined)[] = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { result.push(undefined); continue; }
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i < period) { avgGain += gain; avgLoss += loss; result.push(undefined); continue; }
    if (i === period) { avgGain = (avgGain + gain) / period; avgLoss = (avgLoss + loss) / period; }
    else { avgGain = (avgGain * (period - 1) + gain) / period; avgLoss = (avgLoss * (period - 1) + loss) / period; }
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

// ── ATR ───────────────────────────────────────────────────────────────────────

function atr(highs: number[], lows: number[], closes: number[], period = 14): (number | undefined)[] {
  const result: (number | undefined)[] = [];
  let prev: number | undefined;
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { result.push(undefined); continue; }
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    if (i < period) { result.push(undefined); if (prev === undefined) prev = 0; prev += tr; continue; }
    if (i === period) { prev = (prev! + tr) / period; }
    else { prev = (prev! * (period - 1) + tr) / period; }
    result.push(prev);
  }
  return result;
}

// ── Bollinger Bands ───────────────────────────────────────────────────────────

function bollingerBands(closes: number[], period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper: (number | undefined)[] = [];
  const lower: (number | undefined)[] = [];
  const bandwidth: (number | undefined)[] = [];
  const percentB: (number | undefined)[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (mid[i] == null) { upper.push(undefined); lower.push(undefined); bandwidth.push(undefined); percentB.push(undefined); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += (closes[j] - mid[i]!) ** 2;
    const std = Math.sqrt(sum / period);
    const u = mid[i]! + mult * std;
    const l = mid[i]! - mult * std;
    upper.push(u); lower.push(l);
    bandwidth.push(u - l > 0 ? (u - l) / mid[i]! * 100 : 0);
    percentB.push(u - l > 0 ? (closes[i] - l) / (u - l) : 0.5);
  }
  return { upper, lower, bandwidth, percentB };
}

// ── VWAP（當日重置）─────────────────────────────────────────────────────────

export function computeVWAP(candles: IntradayCandle[]): {
  vwap: number[]; upper: number[]; lower: number[];
} {
  const vwap: number[] = [];
  const upper: number[] = [];
  const lower: number[] = [];

  let cumPV = 0, cumVol = 0, cumPV2 = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumVol += c.volume;
    cumPV2 += tp * tp * c.volume;

    const v = cumVol > 0 ? cumPV / cumVol : tp;
    vwap.push(v);

    // VWAP ± 1 標準差
    if (cumVol > 0) {
      const variance = cumPV2 / cumVol - v * v;
      const std = Math.sqrt(Math.max(0, variance));
      upper.push(v + std);
      lower.push(v - std);
    } else {
      upper.push(v);
      lower.push(v);
    }
  }

  return { vwap, upper, lower };
}

// ── 主入口：計算所有指標 ──────────────────────────────────────────────────────

export function computeIntradayIndicators(
  candles: IntradayCandle[],
): IntradayCandleWithIndicators[] {
  if (candles.length === 0) return [];

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  // 均線
  const ma5Arr  = sma(closes, 5);
  const ma10Arr = sma(closes, 10);
  const ma20Arr = sma(closes, 20);
  const ma60Arr = sma(closes, 60);
  const avgVol5Arr  = sma(volumes, 5);
  const avgVol20Arr = sma(volumes, 20);

  // MACD
  const { dif, signal, osc } = macd(closes);

  // KD
  const { k: kdKArr, d: kdDArr } = kd(highs, lows, closes);

  // RSI
  const rsi14Arr = rsi(closes);

  // ATR
  const atr14Arr = atr(highs, lows, closes);

  // Bollinger Bands
  const bb = bollingerBands(closes);

  // VWAP
  const { vwap: vwapArr, upper: vwapUpper, lower: vwapLower } = computeVWAP(candles);

  // 累積量
  let cumVol = 0;

  return candles.map((c, i) => {
    cumVol += c.volume;
    return {
      ...c,
      ma5:       ma5Arr[i],
      ma10:      ma10Arr[i],
      ma20:      ma20Arr[i],
      ma60:      ma60Arr[i],
      avgVol5:   avgVol5Arr[i],
      avgVol20:  avgVol20Arr[i],
      macdDIF:   dif[i],
      macdSignal: signal[i],
      macdOSC:   osc[i],
      kdK:       kdKArr[i],
      kdD:       kdDArr[i],
      rsi14:     rsi14Arr[i],
      atr14:     atr14Arr[i],
      bbUpper:   bb.upper[i],
      bbLower:   bb.lower[i],
      bbBandwidth: bb.bandwidth[i],
      bbPercentB:  bb.percentB[i],
      vwap:      vwapArr[i],
      vwapUpper: vwapUpper[i],
      vwapLower: vwapLower[i],
      cumulativeVolume: cumVol,
    };
  });
}
