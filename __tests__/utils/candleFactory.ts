/**
 * 0513 ABCDE B2 scaffold — 合成 candle fixtures helper
 *
 * 提供「合理預設」的 candle 序列產生器，給 detector unit tests 用。
 * 不需要每個 test 自己手刻 30+ 根 K 線陣列。
 *
 * Usage:
 *   const candles = makeBullishCandles(50);  // 50 根多頭 K 線
 *   const triggered = makeTriggeredBreakout(50);  // 含突破前 K 高的紅 K
 *   const flat = makeFlatBottom(60);  // 一字底 60 天盤整
 */

import type { CandleWithIndicators, Candle } from '@/types';

/**
 * 產生「多頭趨勢」K 線序列：價格從 80 階梯上漲到 100
 * 含 MA5/10/20/60 indicator（簡單算術平均）
 */
export function makeBullishCandles(n: number, startPrice = 80, endPrice = 100, symbol = 'TEST.TW'): CandleWithIndicators[] {
  const out: CandleWithIndicators[] = [];
  const step = (endPrice - startPrice) / Math.max(1, n - 1);

  for (let i = 0; i < n; i++) {
    const date = isoDate(i, n);
    const open = startPrice + step * i;
    const close = open + step * 0.6;
    const high = close + 0.5;
    const low = open - 0.3;
    out.push({
      date,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: 1_000_000 + i * 10_000,
    });
  }
  computeSimpleMAs(out);
  return out;
}

/**
 * 產生「盤整」K 線：價格在 ±2% 範圍內震盪
 */
export function makeConsolidationCandles(n: number, mid = 100, range = 0.02): CandleWithIndicators[] {
  const out: CandleWithIndicators[] = [];
  for (let i = 0; i < n; i++) {
    const date = isoDate(i, n);
    const offset = Math.sin(i * 0.7) * mid * range;
    const open = mid + offset;
    const close = mid + Math.sin(i * 0.7 + 0.3) * mid * range;
    const high = Math.max(open, close) + 0.2;
    const low = Math.min(open, close) - 0.2;
    out.push({
      date,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: 800_000,
    });
  }
  computeSimpleMAs(out);
  return out;
}

/**
 * 合成「最後一根紅 K + 量 1.3x + 突破前 K 高」— B 字母觸發條件
 */
export function makeBullishWithBreakout(n: number): CandleWithIndicators[] {
  const candles = makeBullishCandles(n);
  const last = candles[n - 1];
  const prev = candles[n - 2];
  // 強制最後一根：紅 K 實體 ≥ 2% + 突破前 K 高 + 量 1.3x
  last.open = prev.close;
  last.close = round(prev.close * 1.025);  // 2.5% red K
  last.high = round(last.close + 0.3);
  last.low = round(prev.close - 0.1);
  last.volume = Math.round(prev.volume * 1.4);
  return candles;
}

// ─── helpers ───────────────────────────────────────────────────────

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 從今天往前數 n-1-i 個交易日的 ISO date（簡化版 — 不考慮週末/假日，給 unit test 用） */
function isoDate(i: number, n: number): string {
  const offset = n - 1 - i;
  const d = new Date('2026-05-13T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/** 計算 MA5/10/20/60 + avgVol */
function computeSimpleMAs(arr: CandleWithIndicators[]): void {
  for (let i = 0; i < arr.length; i++) {
    arr[i].ma5 = sma(arr, i, 5);
    arr[i].ma10 = sma(arr, i, 10);
    arr[i].ma20 = sma(arr, i, 20);
    arr[i].ma60 = sma(arr, i, 60);
    arr[i].avgVol5 = avgVol(arr, i, 5);
    arr[i].avgVol20 = avgVol(arr, i, 20);
  }
}

function sma(arr: CandleWithIndicators[], i: number, period: number): number | undefined {
  if (i + 1 < period) return undefined;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) sum += arr[j].close;
  return round(sum / period);
}

function avgVol(arr: CandleWithIndicators[], i: number, period: number): number | undefined {
  if (i + 1 < period) return undefined;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) sum += arr[j].volume;
  return Math.round(sum / period);
}

export type { CandleWithIndicators, Candle };
