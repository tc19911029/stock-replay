/**
 * trendlineAnalysis.ts — 朱家泓《活用技術分析寶典》切線系統
 *
 * 書中 Part 5 (P348-395) 定義了完整的切線體系：
 * - 原始上升/下降切線
 * - 隨機上升/下降切線
 * - 軌道線（通道）
 * - 切線突破/跌破判斷
 */

import { CandleWithIndicators } from '@/types';
import { computeTurningWave, TurningPoint } from './turningWave';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Trendline {
  type: 'ascending' | 'descending';
  category: 'original' | 'random' | 'steep';
  /** 起點 */
  start: { idx: number; price: number };
  /** 終點 */
  end: { idx: number; price: number };
  /** 斜率（每根K線的價格變化） */
  slope: number;
  /** 在目標 idx 位置的切線價格 */
  priceAt: (idx: number) => number;
}

export interface TrendlineAnalysisResult {
  /** 找到的切線列表 */
  trendlines: Trendline[];
  /** 是否突破下降切線（多方信號） */
  breakAboveDescending: boolean;
  /** 是否跌破上升切線（空方信號） */
  breakBelowAscending: boolean;
  /** 最近的上升切線支撐價 */
  ascendingSupport: number | null;
  /** 最近的下降切線壓力價 */
  descendingResistance: number | null;
  /** 綜合調整分 */
  compositeAdjust: number;
}

// ── Core ────────────────────────────────────────────────────────────────────────

/**
 * 自動偵測切線
 *
 * 書中畫法：
 * - 上升切線：連接 2 個轉折波低點（底底高）
 * - 下降切線：連接 2 個轉折波高點（頭頭低）
 * - 原始切線：趨勢反轉後的第一條切線
 * - 急切線：斜率 > 45度（價格變化率大）
 */
function detectTrendlines(
  points: TurningPoint[],
  candles: CandleWithIndicators[],
  endIdx: number,
): Trendline[] {
  const trendlines: Trendline[] = [];

  // ── 上升切線：連接低點 ──
  const lows = points.filter(p => p.type === 'low' && p.idx <= endIdx);
  for (let i = 0; i < lows.length - 1; i++) {
    const p1 = lows[i];
    const p2 = lows[i + 1];
    if (p2.price > p1.price && p2.idx > p1.idx) {
      const slope = (p2.price - p1.price) / (p2.idx - p1.idx);
      const priceAt = (idx: number) => p1.price + slope * (idx - p1.idx);

      // 判斷類型
      // 急切線：視覺角度 > 60°（網路通用標準，程式交易快譯通/量化通）
      // 換算：假設 x 軸 1 天 = 1 單位，y 軸 1% 均價 = 1 單位
      //   normalizedSlope = (slope / avgPrice) × 100（每日 % 變化）
      //   angle = atan(normalizedSlope) × 180/π
      //   60° ≈ atan(1.732) → 每日 ≈ 2% 變化
      const avgPrice = (p1.price + p2.price) / 2;
      const normalizedSlope = avgPrice > 0 ? (slope / avgPrice) * 100 : 0;
      const angleDeg = Math.atan(normalizedSlope) * 180 / Math.PI;
      const isSteep = angleDeg > 60;

      trendlines.push({
        type: 'ascending',
        category: i === 0 ? 'original' : isSteep ? 'steep' : 'random',
        start: { idx: p1.idx, price: p1.price },
        end: { idx: p2.idx, price: p2.price },
        slope,
        priceAt,
      });
    }
  }

  // ── 下降切線：連接高點 ──
  const highs = points.filter(p => p.type === 'high' && p.idx <= endIdx);
  for (let i = 0; i < highs.length - 1; i++) {
    const p1 = highs[i];
    const p2 = highs[i + 1];
    if (p2.price < p1.price && p2.idx > p1.idx) {
      const slope = (p2.price - p1.price) / (p2.idx - p1.idx);
      const priceAt = (idx: number) => p1.price + slope * (idx - p1.idx);

      // 急切線：視覺角度 > 60°（同升線，絕對值比較）
      const avgPrice = (p1.price + p2.price) / 2;
      const normalizedSlope = avgPrice > 0 ? Math.abs(slope / avgPrice) * 100 : 0;
      const angleDeg = Math.atan(normalizedSlope) * 180 / Math.PI;
      const isSteep = angleDeg > 60;

      trendlines.push({
        type: 'descending',
        category: i === 0 ? 'original' : isSteep ? 'steep' : 'random',
        start: { idx: p1.idx, price: p1.price },
        end: { idx: p2.idx, price: p2.price },
        slope,
        priceAt,
      });
    }
  }

  return trendlines;
}

/**
 * 檢查切線突破/跌破
 *
 * 書中規則：
 * - 突破下降切線 = 空頭轉強信號
 * - 跌破上升切線 = 多頭轉弱信號
 * - 支撐變壓力 / 壓力變支撐
 */
function checkBreakouts(
  trendlines: Trendline[],
  candles: CandleWithIndicators[],
  idx: number,
): { breakAbove: boolean; breakBelow: boolean } {
  const c = candles[idx];
  const prev = idx > 0 ? candles[idx - 1] : null;
  let breakAbove = false;
  let breakBelow = false;

  for (const line of trendlines) {
    const currentLinePrice = line.priceAt(idx);
    const prevLinePrice = prev ? line.priceAt(idx - 1) : currentLinePrice;

    if (line.type === 'descending') {
      // 收盤突破下降切線（前日在下方，今日收在上方）
      if (prev && prev.close <= prevLinePrice && c.close > currentLinePrice) {
        breakAbove = true;
      }
    } else {
      // 收盤跌破上升切線
      if (prev && prev.close >= prevLinePrice && c.close < currentLinePrice) {
        breakBelow = true;
      }
    }
  }

  return { breakAbove, breakBelow };
}

// ── Main Evaluator ──────────────────────────────────────────────────────────────

/**
 * 切線分析
 */
export function analyzeTrendlines(
  candles: CandleWithIndicators[],
  idx: number,
): TrendlineAnalysisResult {
  // 用轉折波的點來畫切線
  const wave = computeTurningWave(candles, idx, 10); // 中線轉折波
  const trendlines = detectTrendlines(wave.points, candles, idx);

  const { breakAbove, breakBelow } = checkBreakouts(trendlines, candles, idx);

  // 找最近的上升切線支撐和下降切線壓力
  let ascendingSupport: number | null = null;
  let descendingResistance: number | null = null;

  const ascending = trendlines.filter(l => l.type === 'ascending');
  const descending = trendlines.filter(l => l.type === 'descending');

  if (ascending.length > 0) {
    const last = ascending[ascending.length - 1];
    ascendingSupport = last.priceAt(idx);
  }
  if (descending.length > 0) {
    const last = descending[descending.length - 1];
    descendingResistance = last.priceAt(idx);
  }

  // 綜合調整分
  let compositeAdjust = 0;
  if (breakAbove) compositeAdjust += 5;  // 突破下降切線 → 利多
  if (breakBelow) compositeAdjust -= 5;  // 跌破上升切線 → 利空

  // 在上升切線支撐附近 → 小加分
  if (ascendingSupport != null && candles[idx].close > 0) {
    const distToSupport = (candles[idx].close - ascendingSupport) / candles[idx].close;
    if (distToSupport >= 0 && distToSupport < 0.03) compositeAdjust += 3;
  }

  return {
    trendlines,
    breakAboveDescending: breakAbove,
    breakBelowAscending: breakBelow,
    ascendingSupport,
    descendingResistance,
    compositeAdjust,
  };
}
