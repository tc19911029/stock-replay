/**
 * 布林通道 8 使用原則 — 書本 Part 8 p.572-582
 *
 * 布林通道 = MA20 中軌 + ±2 標準差上下軌，涵蓋 95.4% 股價。
 * 書本 p.574-576 明寫 4 買訊 + 4 賣訊；p.577-581 進階 8 原則。
 *
 * Note: 需要先計算標準差（std20），若 CandleWithIndicators 沒提供，
 *       這裡用 20 日 close 自算。
 */
import type { CandleWithIndicators } from '@/types';

function calcStd20(candles: CandleWithIndicators[], index: number): number | null {
  if (index < 19) return null;
  let sum = 0, sumSq = 0;
  for (let j = index - 19; j <= index; j++) {
    sum += candles[j].close;
    sumSq += candles[j].close * candles[j].close;
  }
  const n = 20;
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return variance > 0 ? Math.sqrt(variance) : null;
}

export interface BollingerBands {
  upper:  number | null;
  middle: number | null;
  lower:  number | null;
}

export function getBollingerBands(
  candles: CandleWithIndicators[],
  index: number,
): BollingerBands {
  const c = candles[index];
  const std = calcStd20(candles, index);
  if (!c?.ma20 || std == null) return { upper: null, middle: null, lower: null };
  return {
    upper: c.ma20 + 2 * std,
    middle: c.ma20,
    lower: c.ma20 - 2 * std,
  };
}

/** 8 原則回傳（書本 p.574-581） */
export interface BollingerSignals {
  // 4 買訊（書本 p.574）
  buyFromLower:        boolean;  // ① 空頭低檔由下向上穿下軌
  buyBreakMiddle:      boolean;  // ② 多頭穿中軌（回後站回）
  buyAboveMiddle:      boolean;  // ③ 在中上軌間向上持續做多
  buyParallelBreak:    boolean;  // ④ 3 軌平行+突破盤整

  // 4 賣訊（書本 p.575）
  sellFromUpper:       boolean;  // ⑤ 價由上穿下上軌
  sellBreakMiddle:     boolean;  // ⑥ 空頭反彈後跌破中軌
  sellBelowMiddle:     boolean;  // ⑦ 在中下軌間向下持續做空
  sellParallelBreak:   boolean;  // ⑧ 3 軌平行+跌破盤整

  // 進階（p.577-581）
  uptrendSqueeze:      boolean;  // 3 軌平行 + 大量紅K 突破盤整（喇叭開口）
  downtrendSqueeze:    boolean;  // 3 軌平行 + 大量黑K 跌破
  allBandsRising:      boolean;  // 上中下同時向上 = 強勢
  allBandsFalling:     boolean;  // 上中下同時向下 = 弱勢
}

export function detectBollingerSignals(
  candles: CandleWithIndicators[],
  index: number,
): BollingerSignals {
  const empty: BollingerSignals = {
    buyFromLower: false, buyBreakMiddle: false, buyAboveMiddle: false, buyParallelBreak: false,
    sellFromUpper: false, sellBreakMiddle: false, sellBelowMiddle: false, sellParallelBreak: false,
    uptrendSqueeze: false, downtrendSqueeze: false, allBandsRising: false, allBandsFalling: false,
  };
  if (index < 20) return empty;

  const c = candles[index];
  const prev = candles[index - 1];
  const bb = getBollingerBands(candles, index);
  const bbPrev = getBollingerBands(candles, index - 1);
  const bbPrev5 = getBollingerBands(candles, index - 5);
  if (!bb.upper || !bb.middle || !bb.lower || !bbPrev.upper || !bbPrev.middle || !bbPrev.lower) return empty;
  if (!bbPrev5.upper || !bbPrev5.middle || !bbPrev5.lower) return empty;

  // 4 買訊
  const buyFromLower     = prev.close < bbPrev.lower && c.close >= bb.lower && c.close > c.open;
  const buyBreakMiddle   = prev.close < bbPrev.middle && c.close >= bb.middle && c.close > c.open;
  const buyAboveMiddle   = c.close > bb.middle && c.close < bb.upper && bb.middle > bbPrev.middle;
  const parallel         = Math.abs((bb.upper - bb.lower) - (bbPrev5.upper - bbPrev5.lower)) / bb.middle < 0.02;
  const buyParallelBreak = parallel && c.close > bb.upper && c.close > c.open;

  // 4 賣訊（鏡像）
  const sellFromUpper    = prev.close > bbPrev.upper && c.close <= bb.upper && c.close < c.open;
  const sellBreakMiddle  = prev.close > bbPrev.middle && c.close <= bb.middle && c.close < c.open;
  const sellBelowMiddle  = c.close < bb.middle && c.close > bb.lower && bb.middle < bbPrev.middle;
  const sellParallelBreak = parallel && c.close < bb.lower && c.close < c.open;

  // 進階
  const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  const avgVol5 = c.avgVol5 ?? 0;
  const isLargeVol = avgVol5 > 0 && c.volume >= avgVol5 * 1.3;
  const uptrendSqueeze   = parallel && c.close > bb.upper && c.close > c.open && bodyPct >= 0.02 && isLargeVol;
  const downtrendSqueeze = parallel && c.close < bb.lower && c.close < c.open && bodyPct >= 0.02 && isLargeVol;

  const allBandsRising  = bb.upper > bbPrev.upper && bb.middle > bbPrev.middle && bb.lower > bbPrev.lower;
  const allBandsFalling = bb.upper < bbPrev.upper && bb.middle < bbPrev.middle && bb.lower < bbPrev.lower;

  return {
    buyFromLower, buyBreakMiddle, buyAboveMiddle, buyParallelBreak,
    sellFromUpper, sellBreakMiddle, sellBelowMiddle, sellParallelBreak,
    uptrendSqueeze, downtrendSqueeze, allBandsRising, allBandsFalling,
  };
}
