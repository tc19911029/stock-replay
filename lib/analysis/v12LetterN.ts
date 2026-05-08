/**
 * v12 字母 N：型態確認
 *
 * 書本依據：
 * - 寶典 Part 11-1 第 7 位置「等型態確認」p.697
 * - 抓飆股 Part 7「25 種型態附錄」p.314-342（含達成率）
 * - 5 步驟 步驟 1 第 7 章 情況 5 p.110
 *
 * v12 階段 1 實作 3 個高達成率底部型態：
 * - 頭肩底（達成率 83%）
 * - 三重底（達成率 95%）⭐ 最高達成率
 * - 圓弧底（達成率 85%）
 *
 * v12 階段 2 補入：
 * - 複式頭肩底 80% / 跌菱形 80% / 下降楔形 90% / 雙重底 36%
 *
 * 議題 33（第 10 輪修正後）：N 走 LockWatch（頸線突破時 detectTrend
 *   通常還沒翻多 → 觀察階段 → 趨勢確認後升級進場）
 * 議題 6：N 是型態類，套 ×3% + 3 天 provisional
 * 議題 49：N 結構失效 = 跌破對應低點
 *
 * 軌道：reversal（轉折軌）
 * 類別：pattern（型態類）
 */

import type { CandleWithIndicators } from '../../types';

import { findPivots } from './trendAnalysis';
import { isValidRedK } from './redKValidator';
import type { MarketId } from '../scanner/types';

export type PatternType =
  | 'head-shoulder'        // 頭肩底（達成率 83%）
  | 'triple-bottom'        // 三重底（達成率 95%）
  | 'rounding-bottom'      // 圓弧底（達成率 85%）
  // 階段 2 補入：
  | 'complex-head-shoulder'
  | 'falling-diamond'
  | 'descending-wedge'
  | 'double-bottom';

const PATTERN_ACHIEVEMENT: Record<PatternType, number> = {
  'head-shoulder': 83,
  'triple-bottom': 95,
  'rounding-bottom': 85,
  'complex-head-shoulder': 80,
  'falling-diamond': 80,
  'descending-wedge': 90,
  'double-bottom': 36,  // 書本明寫成功率低，仍實作但加警示
};

export interface LetterNResult {
  triggered: boolean;
  /** 偵測到的型態（觸發時必有）*/
  patternType?: PatternType;
  /** 達成率（書本明寫，用於排序）*/
  achievementRate?: number;
  /** 頸線價（突破點）*/
  necklinePrice?: number;
  /** ×3% 真突破門檻 */
  breakoutThreshold?: number;
  /** 型態目標價（用於 Step 5 ② 停利）*/
  patternTargetPrice?: number;
  /** 結構失效點（議題 49）*/
  structureBrokenPrice?: number;
  bodyPct?: number;
  volumeRatio?: number;
  detail: string;
}

const TRUE_BREAKOUT_PCT = 0.03;

/**
 * N 型態確認偵測（階段 1：3 個高達成率型態）
 *
 * 內部依序檢查：三重底 → 頭肩底 → 圓弧底，回傳第一個命中的。
 */
export function detectLetterN(
  candles: CandleWithIndicators[],
  idx: number,
  market: MarketId = 'TW',
  symbol = '',
): LetterNResult {
  const empty: LetterNResult = { triggered: false, detail: 'N 型態確認未觸發' };

  if (idx < 30 || candles.length === 0) return empty;

  const c = candles[idx];
  const prev = candles[idx - 1];
  const prevPrev = candles[idx - 2];
  if (!c || !prev || !prevPrev || prev.volume <= 0 || c.open <= 0) return empty;

  // 共同前置：紅 K + 實體 ≥ 2% + 量 ≥ 1.3
  if (!isValidRedK(c, prevPrev.close, market, symbol)) return empty;
  const bodyPct = ((c.close - c.open) / c.open) * 100;
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < 1.3) return empty;

  // 依序試 3 個型態
  const tripleBottom = detectTripleBottom(candles, idx);
  if (tripleBottom) {
    return makeResult(tripleBottom, c.close, bodyPct, volumeRatio);
  }

  const headShoulder = detectHeadShoulder(candles, idx);
  if (headShoulder) {
    return makeResult(headShoulder, c.close, bodyPct, volumeRatio);
  }

  const roundingBottom = detectRoundingBottom(candles, idx);
  if (roundingBottom) {
    return makeResult(roundingBottom, c.close, bodyPct, volumeRatio);
  }

  return empty;
}

interface PatternMatch {
  patternType: PatternType;
  necklinePrice: number;
  patternTargetPrice: number;
  structureBrokenPrice: number;
}

function makeResult(
  match: PatternMatch,
  closePrice: number,
  bodyPct: number,
  volumeRatio: number,
): LetterNResult {
  const breakoutThreshold = match.necklinePrice * (1 + TRUE_BREAKOUT_PCT);

  // 真突破檢查：close ≥ neckline × 1.03
  if (closePrice < breakoutThreshold) {
    return { triggered: false, detail: 'N 型態結構成立但未過 ×3% 真突破' };
  }

  return {
    triggered: true,
    patternType: match.patternType,
    achievementRate: PATTERN_ACHIEVEMENT[match.patternType],
    necklinePrice: match.necklinePrice,
    breakoutThreshold,
    patternTargetPrice: match.patternTargetPrice,
    structureBrokenPrice: match.structureBrokenPrice,
    bodyPct,
    volumeRatio,
    detail: `N ${getPatternName(match.patternType)}（達成率 ${PATTERN_ACHIEVEMENT[match.patternType]}%+突破頸線 ${match.necklinePrice.toFixed(2)}×3%+紅K${bodyPct.toFixed(2)}%）`,
  };
}

function getPatternName(t: PatternType): string {
  const names: Record<PatternType, string> = {
    'head-shoulder': '頭肩底',
    'triple-bottom': '三重底',
    'rounding-bottom': '圓弧底',
    'complex-head-shoulder': '複式頭肩底',
    'falling-diamond': '跌菱形',
    'descending-wedge': '下降楔形',
    'double-bottom': '雙重底',
  };
  return names[t];
}

// ── 三重底（書本達成率 95%，3 個轉折低點價位相近）─────────────────────────

const TRIPLE_BOTTOM_TOLERANCE_PCT = 0.05; // 3 低點價位差 ≤ 5%

function detectTripleBottom(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 12, false);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 3);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);

  if (lows.length < 3 || highs.length < 2) return null;

  // 三低點價位相近
  const [low1, low2, low3] = lows; // 由新到舊
  const minLow = Math.min(low1.price, low2.price, low3.price);
  const maxLow = Math.max(low1.price, low2.price, low3.price);
  if ((maxLow - minLow) / minLow > TRIPLE_BOTTOM_TOLERANCE_PCT) return null;

  // 頸線 = 兩個 high 連線中較低的（保守取較低）
  const necklinePrice = Math.min(highs[0].price, highs[1].price);

  // 三重底目標價 = 頸線 + 平均底部到頸線高度
  const avgLow = (low1.price + low2.price + low3.price) / 3;
  const patternTargetPrice = necklinePrice + (necklinePrice - avgLow);

  // 結構失效 = 跌破第 3 個底（最新的 low）
  const structureBrokenPrice = low1.price;

  return {
    patternType: 'triple-bottom',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
  };
}

// ── 頭肩底（書本達成率 83%）──────────────────────────────────────────────

function detectHeadShoulder(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 10, false);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 3);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);

  if (lows.length < 3 || highs.length < 2) return null;

  // 由新到舊：right shoulder, head, left shoulder
  const [rightShoulder, head, leftShoulder] = lows;

  // 頭部低於兩肩（書本「頭低於兩肩」）
  if (head.price >= rightShoulder.price || head.price >= leftShoulder.price) {
    return null;
  }

  // 兩肩價位接近（差 < 10%）
  const shoulderDiff = Math.abs(rightShoulder.price - leftShoulder.price);
  const shoulderAvg = (rightShoulder.price + leftShoulder.price) / 2;
  if (shoulderDiff / shoulderAvg > 0.10) return null;

  // 頸線 = 兩個 high 連線（取兩高點較低者保守處理）
  const necklinePrice = Math.min(highs[0].price, highs[1].price);

  // 目標價 = 頸線 + (頸線 - 頭部最低)（書本明寫公式）
  const patternTargetPrice = necklinePrice + (necklinePrice - head.price);

  // 結構失效 = 跌破右肩
  const structureBrokenPrice = rightShoulder.price;

  return {
    patternType: 'head-shoulder',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
  };
}

// ── 圓弧底（書本達成率 85%）──────────────────────────────────────────────

function detectRoundingBottom(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  // 圓弧底：碗狀，底部漸進形成，需要至少 20 根 K 線觀察
  const lookback = 30;
  const start = Math.max(0, idx - lookback);
  if (idx - start < 20) return null;

  let arcLow = Infinity;
  let arcLowIdx = -1;
  for (let i = start; i <= idx; i++) {
    if (candles[i].low < arcLow) {
      arcLow = candles[i].low;
      arcLowIdx = i;
    }
  }

  // 弧底大致在中間（前後比例不超過 1:3 / 3:1）
  const beforeLen = arcLowIdx - start;
  const afterLen = idx - arcLowIdx;
  if (beforeLen < 5 || afterLen < 5) return null;
  if (beforeLen > afterLen * 3 || afterLen > beforeLen * 3) return null;

  // 弧底前最高 + 弧底後最高（取較低者作頸線）
  let beforeHigh = -Infinity;
  let afterHigh = -Infinity;
  for (let i = start; i <= arcLowIdx; i++) {
    if (candles[i].high > beforeHigh) beforeHigh = candles[i].high;
  }
  for (let i = arcLowIdx; i <= idx; i++) {
    if (candles[i].high > afterHigh) afterHigh = candles[i].high;
  }
  const necklinePrice = Math.min(beforeHigh, afterHigh);

  // 弧底深度
  const arcDepth = necklinePrice - arcLow;
  if (arcDepth <= 0) return null;

  // 目標價 = 頸線 + 弧底深度 × 1.5（書本公式）
  const patternTargetPrice = necklinePrice + arcDepth * 1.5;

  return {
    patternType: 'rounding-bottom',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice: arcLow,
  };
}
