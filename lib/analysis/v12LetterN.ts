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

  // 依序試 7 個型態（按達成率降序：三重底 95% → 下降楔形 90% → 圓弧底 85% → 頭肩底 83% → 複式頭肩底/跌菱形 80% → 雙重底 36%）
  const tripleBottom = detectTripleBottom(candles, idx);
  if (tripleBottom) return makeResult(tripleBottom, c.close, bodyPct, volumeRatio);

  const descendingWedge = detectDescendingWedge(candles, idx);
  if (descendingWedge) return makeResult(descendingWedge, c.close, bodyPct, volumeRatio);

  const roundingBottom = detectRoundingBottom(candles, idx);
  if (roundingBottom) return makeResult(roundingBottom, c.close, bodyPct, volumeRatio);

  const headShoulder = detectHeadShoulder(candles, idx);
  if (headShoulder) return makeResult(headShoulder, c.close, bodyPct, volumeRatio);

  const complexHeadShoulder = detectComplexHeadShoulder(candles, idx);
  if (complexHeadShoulder) return makeResult(complexHeadShoulder, c.close, bodyPct, volumeRatio);

  const fallingDiamond = detectFallingDiamond(candles, idx);
  if (fallingDiamond) return makeResult(fallingDiamond, c.close, bodyPct, volumeRatio);

  const doubleBottom = detectDoubleBottom(candles, idx);
  if (doubleBottom) return makeResult(doubleBottom, c.close, bodyPct, volumeRatio);

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
    detail: `N ${getPatternName(match.patternType)}（達成率 ${PATTERN_ACHIEVEMENT[match.patternType]}%${PATTERN_ACHIEVEMENT[match.patternType] < 50 ? ' ⚠️ 低達成率' : ''}+突破頸線 ${match.necklinePrice.toFixed(2)}×3%+紅K${bodyPct.toFixed(2)}%）`,
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
  const allHighs = pivots.filter(p => p.type === 'high');

  if (lows.length < 3 || allHighs.length < 2) return null;

  // 三低點價位相近
  const [low1, low2, low3] = lows; // 由新到舊
  const minLow = Math.min(low1.price, low2.price, low3.price);
  const maxLow = Math.max(low1.price, low2.price, low3.price);
  if ((maxLow - minLow) / minLow > TRIPLE_BOTTOM_TOLERANCE_PCT) return null;

  // 頸線必須由「三個底之間的兩個內部高點」組成
  // 過濾 highs：index 在 [low3.index, low1.index] 範圍內（lows 是新→舊，所以 low3.index < low1.index）
  const interiorHighs = allHighs.filter(
    (h) => h.index > low3.index && h.index < low1.index,
  );
  if (interiorHighs.length < 2) return null;

  // 頸線 = 兩內部高點連線中較低（保守取較低 — 突破時需要過此價）
  const necklinePrice = Math.min(interiorHighs[0].price, interiorHighs[1].price);

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
  const allHighs = pivots.filter(p => p.type === 'high');

  if (lows.length < 3 || allHighs.length < 2) return null;

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

  // 頸線必須由「三低點之間的兩內部高點」組成（書本「左頸線 + 右頸線」）
  // lows 新→舊：rightShoulder.index > head.index > leftShoulder.index
  // 內部高點：left-high 在 leftShoulder 與 head 之間；right-high 在 head 與 rightShoulder 之間
  const interiorHighs = allHighs.filter(
    (h) => h.index > leftShoulder.index && h.index < rightShoulder.index,
  );
  if (interiorHighs.length < 2) return null;

  // 頸線 = 兩內部高點連線中較低
  const necklinePrice = Math.min(interiorHighs[0].price, interiorHighs[1].price);

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

// ── 下降楔形（書本達成率 90%，2026-05-09 補實作）─────────────────────────────
//
// 抓住線圖型態附錄：高點下降切線 + 低點下降切線收斂，突破上切線做多
// 條件：
//   1. ≥ 2 個 confirmed highs 且 highs[0] < highs[1]（高點下降）
//   2. ≥ 2 個 confirmed lows  且 lows[0] < lows[1] （低點下降）
//   3. 高點下降斜率（更陡）> 低點下降斜率（較緩）— 兩線收斂
//   4. 收盤突破今日「兩高點延伸線」

const WEDGE_CONVERGENCE_RATIO = 1.2; // 高點下降速度至少是低點的 1.2x（收斂）

function detectDescendingWedge(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 10, false);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const lows  = pivots.filter(p => p.type === 'low').slice(0, 2);
  if (highs.length < 2 || lows.length < 2) return null;

  // 高點 + 低點都要下降
  if (highs[0].price >= highs[1].price) return null;
  if (lows[0].price >= lows[1].price) return null;

  // 高點下降斜率（單位：價/天，取絕對值）
  const highSpan = highs[1].index - highs[0].index;
  const lowSpan  = lows[1].index  - lows[0].index;
  if (highSpan <= 0 || lowSpan <= 0) return null;
  const highSlope = (highs[1].price - highs[0].price) / highSpan;
  const lowSlope  = (lows[1].price  - lows[0].price)  / lowSpan;

  // 高點降速 > 低點降速 × 1.2 = 收斂
  if (highSlope <= lowSlope * WEDGE_CONVERGENCE_RATIO) return null;

  // 兩高點延伸線今日值（hNew + 斜率 × (今日 - hNew.index)）
  // 注意：highs[0] 比較新（index 較大），slope 為正（後高 > 前高的方向，但這裡前高>後高所以 slope 為負）
  // 重新計算：用 highs[1] (older) → highs[0] (newer)
  const slopeForLine = (highs[0].price - highs[1].price) / (highs[0].index - highs[1].index); // 負值
  const upperToday = highs[0].price + slopeForLine * (idx - highs[0].index);
  if (upperToday <= 0) return null;

  // 收盤突破上切線
  if (candles[idx].close <= upperToday) return null;

  // 楔形目標 = 突破點 + 楔形最大寬度（書本未明寫公式，採保守值：頸線+楔形入口寬度）
  const wedgeWidth = highs[1].price - lows[1].price;
  const patternTargetPrice = upperToday + wedgeWidth;

  return {
    patternType: 'descending-wedge',
    necklinePrice: upperToday,
    patternTargetPrice,
    structureBrokenPrice: lows[0].price,  // 跌破最近低 = 結構失效
  };
}

// ── 複式頭肩底（書本達成率 80%，2026-05-09 補實作）──────────────────────────
//
// 多頭肩 + 頭 + 多右肩。簡化實作：≥ 5 個 confirmed lows，最低位於中間（頭），
// 兩側肩價位接近（差 < 15%）。
//
// 跟一般頭肩底差別：兩側肩可以各 ≥ 2 個（不只 1 個）

function detectComplexHeadShoulder(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 12, false);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 5);
  const allHighs = pivots.filter(p => p.type === 'high');
  if (lows.length < 5) return null;

  // 找最低（頭），必須在中間（不能是最新或最舊）
  let headIdx = -1;
  let headPrice = Infinity;
  for (let i = 0; i < lows.length; i++) {
    if (lows[i].price < headPrice) {
      headPrice = lows[i].price;
      headIdx = i;
    }
  }
  if (headIdx === 0 || headIdx === lows.length - 1) return null;  // 頭必須在中間

  const head = lows[headIdx];
  const leftShoulders = lows.slice(headIdx + 1);   // 較舊（lows 由新→舊）
  const rightShoulders = lows.slice(0, headIdx);   // 較新

  // 兩側肩各至少 1 個（簡化版至少 1+1，書本「複式」 ≥ 2+2 我們放寬以提高觸發率）
  if (leftShoulders.length < 1 || rightShoulders.length < 1) return null;

  // 兩側肩價位接近（取兩側平均，差 < 15%）
  const leftAvg = leftShoulders.reduce((s, p) => s + p.price, 0) / leftShoulders.length;
  const rightAvg = rightShoulders.reduce((s, p) => s + p.price, 0) / rightShoulders.length;
  const shoulderAvg = (leftAvg + rightAvg) / 2;
  if (Math.abs(leftAvg - rightAvg) / shoulderAvg > 0.15) return null;

  // 兩側肩都必須高於頭
  if (leftAvg <= head.price || rightAvg <= head.price) return null;

  // 頸線：頭兩側內部高點（在 head 跟兩側肩之間），取較低
  const oldestShoulderIdx = leftShoulders[leftShoulders.length - 1].index;
  const newestShoulderIdx = rightShoulders[0].index;
  const interiorHighs = allHighs.filter(
    h => h.index > oldestShoulderIdx && h.index < newestShoulderIdx,
  );
  if (interiorHighs.length < 2) return null;
  const necklinePrice = Math.min(...interiorHighs.map(h => h.price));

  // 目標價 = 頸線 + (頸線 - 頭部最低)
  const patternTargetPrice = necklinePrice + (necklinePrice - head.price);
  // 結構失效 = 跌破最新右肩
  const structureBrokenPrice = rightShoulders[0].price;

  return {
    patternType: 'complex-head-shoulder',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
  };
}

// ── 跌菱形（書本達成率 80%，2026-05-09 補實作）────────────────────────────
//
// 高點先擴大後收斂的菱形結構：4 個 confirmed highs
//   - 較舊 2 高擴張（後高 > 前高）
//   - 較新 2 高收斂（後高 < 前高）
// 突破上頸線做多

function detectFallingDiamond(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 12, false);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 4);
  const lows  = pivots.filter(p => p.type === 'low').slice(0, 4);
  if (highs.length < 4 || lows.length < 2) return null;

  // highs 由新→舊：[h0, h1, h2, h3]
  // 較舊 2 高擴張：h3 < h2（後高 > 前高）
  // 較新 2 高收斂：h0 < h1（後高 < 前高）
  const [h0, h1, h2, h3] = highs;
  if (h3.price >= h2.price) return null;  // 較舊段必須擴張
  if (h0.price >= h1.price) return null;  // 較新段必須收斂

  // 菱形最高 = h1 或 h2 中較高（菱形頂點附近）
  const peakHigh = Math.max(h1.price, h2.price);

  // 收盤突破菱形最高（即上頸線）
  if (candles[idx].close <= peakHigh) return null;

  // 目標價 = 突破點 + 菱形高度（最高 - 最低）
  const peakLow = Math.min(...lows.map(l => l.price));
  const diamondHeight = peakHigh - peakLow;
  const patternTargetPrice = peakHigh + diamondHeight;

  return {
    patternType: 'falling-diamond',
    necklinePrice: peakHigh,
    patternTargetPrice,
    structureBrokenPrice: peakLow,
  };
}

// ── 雙重底（書本達成率 36%，2026-05-09 補實作；低達成率加警示）────────────
//
// 2 個價位接近的 confirmed lows + 中間 1 個 confirmed high 當頸線
// 收盤突破頸線做多

const DOUBLE_BOTTOM_TOLERANCE_PCT = 0.05; // 兩底價位差 ≤ 5%

function detectDoubleBottom(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 10, false);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 2);
  const allHighs = pivots.filter(p => p.type === 'high');
  if (lows.length < 2) return null;

  // 兩底價位接近
  const [low1, low2] = lows;  // 由新到舊
  const minLow = Math.min(low1.price, low2.price);
  const maxLow = Math.max(low1.price, low2.price);
  if ((maxLow - minLow) / minLow > DOUBLE_BOTTOM_TOLERANCE_PCT) return null;

  // 中間至少 1 個 confirmed high（頸線）
  const interiorHighs = allHighs.filter(h => h.index > low2.index && h.index < low1.index);
  if (interiorHighs.length < 1) return null;

  // 頸線 = 中間最高點（雙底突破頸線後做多）
  const necklinePrice = Math.max(...interiorHighs.map(h => h.price));

  // 目標價 = 頸線 + (頸線 - 兩底平均)
  const avgLow = (low1.price + low2.price) / 2;
  const patternTargetPrice = necklinePrice + (necklinePrice - avgLow);

  return {
    patternType: 'double-bottom',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice: low1.price,  // 跌破最新底 = 結構失效
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
