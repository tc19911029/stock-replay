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

import { findPivots, type Pivot } from './trendAnalysis';
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
  | 'double-bottom'
  // 2026-05-10 補入：
  | 'n-shape';             // N 字底（A 高→B 低→C 突破 A 高）

/** 頂部型態（向下跌破做空 / 出場警示，2026-05-10 補實作） */
export type TopPatternType =
  | 'head-shoulder-top'    // 頭肩頂
  | 'triple-top'           // 三重頂
  | 'double-top';          // 雙重頂

const PATTERN_ACHIEVEMENT: Record<PatternType, number> = {
  'head-shoulder': 83,
  'triple-bottom': 95,
  'rounding-bottom': 85,
  'complex-head-shoulder': 80,
  'falling-diamond': 80,
  'descending-wedge': 90,
  'double-bottom': 36,  // 書本明寫成功率低，仍實作但加警示
  'n-shape': 75,        // 書本未明寫達成率，採保守估值
};

const TOP_PATTERN_ACHIEVEMENT: Record<TopPatternType, number> = {
  'head-shoulder-top': 83,  // 對稱頭肩底
  'triple-top': 95,         // 對稱三重底
  'double-top': 36,         // 對稱雙重底
};

export interface LetterNResult {
  triggered: boolean;
  /** 偵測到的型態（觸發時必有；結構成立但未過真突破時也會回傳，用於走圖視覺化）*/
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
  /** 構成形態的關鍵 pivot 點，順序與型態 detector 內部一致（走圖視覺化用）*/
  pivots?: Pivot[];
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

  // 依序試 8 個型態（按達成率降序）：
  //   三重底 95% → 下降楔形 90% → 圓弧底 85% → 頭肩底 83% →
  //   複式頭肩底/跌菱形 80% → N 字底 75% → 雙重底 36%
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

  const nShape = detectNShape(candles, idx);
  if (nShape) return makeResult(nShape, c.close, bodyPct, volumeRatio);

  const doubleBottom = detectDoubleBottom(candles, idx);
  if (doubleBottom) return makeResult(doubleBottom, c.close, bodyPct, volumeRatio);

  return empty;
}

/**
 * 結構偵測（走圖視覺化用）：跳過紅K / 量比 / 真突破 gate，
 * 只回傳「形態結構是否成立」+ pivots / 頸線 / 目標 / 結構失效。
 * triggered 永遠 false（不是進場訊號），用 patternType / pivots 判斷有無結構。
 */
export function detectLetterNStructure(
  candles: CandleWithIndicators[],
  idx: number,
): LetterNResult {
  if (idx < 30 || candles.length === 0) return { triggered: false, detail: '' };

  const detectors = [
    detectTripleBottom, detectDescendingWedge, detectRoundingBottom,
    detectHeadShoulder, detectComplexHeadShoulder, detectFallingDiamond,
    detectNShape, detectDoubleBottom,
  ];
  for (const d of detectors) {
    const m = d(candles, idx);
    if (m) {
      return {
        triggered: false,
        patternType: m.patternType,
        achievementRate: PATTERN_ACHIEVEMENT[m.patternType],
        necklinePrice: m.necklinePrice,
        breakoutThreshold: m.necklinePrice * (1 + TRUE_BREAKOUT_PCT),
        patternTargetPrice: m.patternTargetPrice,
        // 結構失效門檻 = 頸線 ×0.97（與真突破對稱）
        structureBrokenPrice: m.structureBrokenPrice * (1 - TRUE_BREAKOUT_PCT),
        pivots: m.pivots,
        detail: `結構偵測：${getPatternName(m.patternType)}`,
      };
    }
  }
  return { triggered: false, detail: '無底部型態結構' };
}

interface PatternMatch {
  patternType: PatternType;
  necklinePrice: number;
  patternTargetPrice: number;
  structureBrokenPrice: number;
  /** 構成形態的關鍵點，順序由各 detector 決定（CandleChart 依 patternType 推標籤）*/
  pivots: Pivot[];
}

function makeResult(
  match: PatternMatch,
  closePrice: number,
  bodyPct: number,
  volumeRatio: number,
): LetterNResult {
  const breakoutThreshold = match.necklinePrice * (1 + TRUE_BREAKOUT_PCT);
  // 結構失效門檻 = 頸線 ×0.97（與真突破對稱，書本對「跌破」也用 ×3% 確認）
  const structureBrokenThreshold = match.structureBrokenPrice * (1 - TRUE_BREAKOUT_PCT);

  // 結構成立但未過真突破 / 已達目標：triggered=false，但仍回傳 pivots+頸線等供走圖視覺化
  const structureOnly = (detail: string): LetterNResult => ({
    triggered: false,
    patternType: match.patternType,
    achievementRate: PATTERN_ACHIEVEMENT[match.patternType],
    necklinePrice: match.necklinePrice,
    breakoutThreshold,
    patternTargetPrice: match.patternTargetPrice,
    structureBrokenPrice: structureBrokenThreshold,
    pivots: match.pivots,
    detail,
  });

  // 真突破檢查：close ≥ neckline × 1.03
  if (closePrice < breakoutThreshold) {
    return structureOnly('N 型態結構成立但未過 ×3% 真突破');
  }

  // 2026-05-11 補：close 已遠超頸線 ≥ 20% 表示突破已發生很久，detector 偵測到的
  // 是舊型態的延伸線（如 002788.SZ neckline 10.12 vs close 14.17 = +40%），
  // 不該算「即將/剛突破」清單。書本本意：突破當下進場，不追過頭。
  if (closePrice > match.necklinePrice * 1.20) {
    return structureOnly('N 型態 close 已遠超頸線（>+20%），突破已發生很久非進場時機');
  }

  // 2026-05-10 補：close 已超過 patternTargetPrice × 0.97 視為「型態已達目標」，
  // 不再算進場訊號（避免 4722.TW 這種 close=236 但 target 才 193 的「過晚觸發」雜訊）
  // 書本《抓飆股》Part 7：型態突破後達目標即啟動停利，不會再被視為新進場機會
  if (closePrice >= match.patternTargetPrice * 0.97) {
    return structureOnly('N 型態已接近/超過目標價，視為已達標非進場時機');
  }

  return {
    triggered: true,
    patternType: match.patternType,
    achievementRate: PATTERN_ACHIEVEMENT[match.patternType],
    necklinePrice: match.necklinePrice,
    breakoutThreshold,
    patternTargetPrice: match.patternTargetPrice,
    structureBrokenPrice: structureBrokenThreshold,
    pivots: match.pivots,
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
    'n-shape': 'N 字底',
  };
  return names[t];
}

function getTopPatternName(t: TopPatternType): string {
  const names: Record<TopPatternType, string> = {
    'head-shoulder-top': '頭肩頂',
    'triple-top': '三重頂',
    'double-top': '雙重頂',
  };
  return names[t];
}

// ── 三重底（書本達成率 95%，3 個轉折低點價位相近）─────────────────────────

const TRIPLE_BOTTOM_TOLERANCE_PCT = 0.05; // 3 低點價位差 ≤ 5%

function detectTripleBottom(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 12, false, 0.005);
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

  // 三重底目標價 = 頸線 + (頸線 - 三底最低點)
  // 書本《抓飆股》Part 7：用最低點測量幅度，不用平均
  const lowestLow = Math.min(low1.price, low2.price, low3.price);
  const patternTargetPrice = necklinePrice + (necklinePrice - lowestLow);

  // 結構失效 = 跌破頸線（書本《抓飆股》Part 7 標準：突破後回測頸線跌破則結構破壞）
  const structureBrokenPrice = necklinePrice;

  // pivots 順序：3 lows (新→舊) + 2 interior highs（標籤 L1/L2/L3 + H1/H2）
  return {
    patternType: 'triple-bottom',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
    pivots: [low1, low2, low3, interiorHighs[0], interiorHighs[1]],
  };
}

// ── 頭肩底（書本達成率 83%）──────────────────────────────────────────────

function detectHeadShoulder(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 10, false, 0.005);
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

  // 結構失效 = 跌破頸線（書本標準：突破後回測頸線跌破則結構破壞）
  const structureBrokenPrice = necklinePrice;

  // pivots 順序：RS / Head / LS + 2 interior necks（標籤 RS/H/LS + RN/LN）
  return {
    patternType: 'head-shoulder',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
    pivots: [rightShoulder, head, leftShoulder, interiorHighs[0], interiorHighs[1]],
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
  const pivots = findPivots(candles, idx, 10, false, 0.005);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const lows  = pivots.filter(p => p.type === 'low').slice(0, 2);
  if (highs.length < 2 || lows.length < 2) return null;

  // 高點 + 低點都要下降
  if (highs[0].price >= highs[1].price) return null;
  if (lows[0].price >= lows[1].price) return null;

  // 高點下降斜率（單位：價/天，取絕對值）
  // pivots 是 newest-first，highs[0] 較新（index 大）、highs[1] 較舊（index 小）
  // 修正：span = newer - older = 正數（原本寫反了 → highSpan 永遠 ≤ 0 → 永遠 return null）
  const highSpan = highs[0].index - highs[1].index;
  const lowSpan  = lows[0].index  - lows[1].index;
  // 最低 5 天 span — 避免交界日雙重 pivot 產生 1-day 不穩定斜率
  // （楔形結構至少要橫跨 1 週才有意義）
  if (highSpan < 5 || lowSpan < 5) return null;
  // 取絕對值（descending 時 highs[1].price > highs[0].price，差為負，除以正 span 為負，加 abs）
  const highSlope = Math.abs(highs[1].price - highs[0].price) / highSpan;
  const lowSlope  = Math.abs(lows[1].price  - lows[0].price)  / lowSpan;

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

  // pivots 順序：2 highs (新→舊) + 2 lows (新→舊)（標籤 H1/H2 + L1/L2）
  return {
    patternType: 'descending-wedge',
    necklinePrice: upperToday,
    patternTargetPrice,
    structureBrokenPrice: upperToday,  // 跌破上切線 = 結構失效（書本標準：突破點即頸線）
    pivots: [highs[0], highs[1], lows[0], lows[1]],
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
  const pivots = findPivots(candles, idx, 12, false, 0.005);
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
  // 結構失效 = 跌破頸線（書本標準）
  const structureBrokenPrice = necklinePrice;

  // pivots 順序：rightShoulders (新→舊) + head + leftShoulders (新→舊) + interiorHighs (前 2)
  // 走圖顯示「複式頭肩底」的所有低點 + 兩個關鍵頸線高點
  return {
    patternType: 'complex-head-shoulder',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
    pivots: [...rightShoulders, head, ...leftShoulders, interiorHighs[0], interiorHighs[1]],
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
  const pivots = findPivots(candles, idx, 12, false, 0.005);
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

  // pivots 順序：4 highs (新→舊) + 4 lows (新→舊)（標籤 H1-H4 + L1-L4）
  return {
    patternType: 'falling-diamond',
    necklinePrice: peakHigh,
    patternTargetPrice,
    structureBrokenPrice: peakHigh,  // 跌破頸線（菱形上頸線=peakHigh）
    pivots: [...highs, ...lows],
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
  const pivots = findPivots(candles, idx, 10, false, 0.005);
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

  // 目標價 = 頸線 + (頸線 - 兩底最低)
  // 書本《抓飆股》Part 7：用最低點測量幅度，不用平均
  const lowestLow = Math.min(low1.price, low2.price);
  const patternTargetPrice = necklinePrice + (necklinePrice - lowestLow);

  // pivots 順序：2 lows (新→舊) + 中間最高高點（標籤 L1/L2 + H）
  const peakHigh = interiorHighs.find(h => h.price === necklinePrice) ?? interiorHighs[0];
  return {
    patternType: 'double-bottom',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice: necklinePrice,  // 跌破頸線（書本標準）
    pivots: [low1, low2, peakHigh],
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
  let beforeHighIdx = start;
  let afterHigh = -Infinity;
  let afterHighIdx = arcLowIdx;
  for (let i = start; i <= arcLowIdx; i++) {
    if (candles[i].high > beforeHigh) { beforeHigh = candles[i].high; beforeHighIdx = i; }
  }
  for (let i = arcLowIdx; i <= idx; i++) {
    if (candles[i].high > afterHigh) { afterHigh = candles[i].high; afterHighIdx = i; }
  }
  const necklinePrice = Math.min(beforeHigh, afterHigh);

  // 弧底深度
  const arcDepth = necklinePrice - arcLow;
  if (arcDepth <= 0) return null;

  // 目標價 = 頸線 + 弧底深度
  // 書本《抓飆股》Part 7：圓弧底測量幅度為「頸線 + 弧底到頸線的高度」（不額外乘 1.5）
  const patternTargetPrice = necklinePrice + arcDepth;

  // pivots 順序：弧後高 (新) + 最低點 + 弧前高 (舊)（標籤 H1/Lowest/H2）
  return {
    patternType: 'rounding-bottom',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice: necklinePrice,  // 跌破頸線（書本標準；之前誤標為弧底）
    pivots: [
      { index: afterHighIdx,  price: afterHigh,  type: 'high' },
      { index: arcLowIdx,     price: arcLow,     type: 'low'  },
      { index: beforeHighIdx, price: beforeHigh, type: 'high' },
    ],
  };
}

// ── N 字底（2026-05-10 補實作）──────────────────────────────────────────────
//
// 書本《抓飆股》Part 7：上漲中的回測再攻
//   結構：A（高）→ B（低，不破前低）→ C（紅K收盤過 A 高）
//   目標 = C 突破點 + (A 高 − B 低)
//   結構失效 = 跌破 B 低
//
// 與其他底部型態不同：N 字底前提是「已在上漲」，B 不創新低，
// 是回檔後再攻創新高的延續型態（接近 P 高檔拉回但有頭部突破要件）

function detectNShape(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 8, false, 0.005);
  // 需要近期 1 個 high (A) → 1 個 low (B)
  // pivots 由新到舊，最新是 high (A 已被超越的舊高)，再來是 low (B)
  const highs = pivots.filter(p => p.type === 'high');
  const lows  = pivots.filter(p => p.type === 'low');
  if (highs.length < 1 || lows.length < 1) return null;

  const a = highs[0];  // A：最近的高
  const b = lows[0];   // B：最近的低

  // B 必須晚於 A（A→B 順序）— 回檔型態才合理
  if (b.index <= a.index) return null;

  // 收盤要過 A 高（×3% 真突破由 makeResult 統一檢查；這裡先確保結構）
  if (candles[idx].close <= a.price) return null;

  // B 不破前低：必須有更早的低點作為比較基準，且 B 嚴格高於它
  // 若無更早 pivot，無從判斷「不破底」結構是否成立 → reject（避免 vacuous pass）
  const prevLow = lows[1];
  if (!prevLow || b.price <= prevLow.price) return null;

  // 目標價 = A 高（突破點）+ (A 高 - B 低)
  // 書本《抓飆股》Part 7：N 字底突破 A 高後再漲 nHeight 距離（往上的另一個 N）
  // 2026-05-10 修：原邏輯用 close 當突破點 → target 跟著 close 漂移，
  //   無法被 makeResult 的「close >= target × 0.97」過濾「已達標」case；
  //   且跟其他型態不一致（其他都是 neckline + height）
  const nHeight = a.price - b.price;
  if (nHeight <= 0) return null;
  const patternTargetPrice = a.price + nHeight;

  // pivots 順序：A 高（突破點）+ B 低（標籤 A/B）
  return {
    patternType: 'n-shape',
    necklinePrice: a.price,           // A 高 = 突破點
    patternTargetPrice,
    structureBrokenPrice: a.price,    // 跌破頸線（A 高 = 突破點 = 頸線）；書本標準
    pivots: [a, b],
  };
}

// ── 頂部型態（2026-05-10 補實作）── 出場用，獨立於 detectLetterN 流程 ────────────
//
// 觸發條件：紅 K 反向（黑 K）+ 跌破頸線
// 目標價：頸線 - (頂高 - 頸線)
// 結構失效（停損點）：再過頸線

interface TopPatternMatch {
  patternType: TopPatternType;
  necklinePrice: number;
  patternTargetPrice: number;
  structureBrokenPrice: number;
  /** 構成形態的關鍵點，順序由各 detector 決定（CandleChart 依 patternType 推標籤）*/
  pivots: Pivot[];
}

export interface TopPatternResult {
  triggered: boolean;
  patternType?: TopPatternType;
  achievementRate?: number;
  necklinePrice?: number;
  /** ×3% 真跌破門檻 */
  breakdownThreshold?: number;
  patternTargetPrice?: number;
  structureBrokenPrice?: number;
  /** 構成形態的關鍵 pivot 點（走圖視覺化用）*/
  pivots?: Pivot[];
  detail: string;
}

const TRUE_BREAKDOWN_PCT = 0.03;

/**
 * 頂部型態偵測（黑K + 跌破頸線×3%）
 *
 * 內部依序檢查：三重頂 → 頭肩頂 → 雙重頂，回傳第一個命中的。
 */
export function detectTopPatterns(
  candles: CandleWithIndicators[],
  idx: number,
): TopPatternResult {
  const empty: TopPatternResult = { triggered: false, detail: '頂部型態未觸發' };
  if (idx < 30 || candles.length === 0) return empty;

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev || prev.volume <= 0 || c.open <= 0) return empty;

  // 共同前置：黑 K（close < open）+ 實體 ≥ 2% + 量 ≥ 1.3
  // 與 detectLetterN 對稱（書本《抓飆股》Part 7 要求頂部跌破也需爆量確認）
  if (c.close >= c.open) return empty;
  const bodyPct = ((c.open - c.close) / c.open) * 100;
  if (bodyPct < 2.0) return empty;
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < 1.3) return empty;

  const tripleTop = detectTripleTop(candles, idx);
  if (tripleTop) return makeTopResult(tripleTop, c.close);

  const headShoulderTop = detectHeadShoulderTop(candles, idx);
  if (headShoulderTop) return makeTopResult(headShoulderTop, c.close);

  const doubleTop = detectDoubleTop(candles, idx);
  if (doubleTop) return makeTopResult(doubleTop, c.close);

  return empty;
}

/**
 * 頂部結構偵測（走圖視覺化用）：跳過黑K / 量比 / 真跌破 gate。
 */
export function detectTopPatternsStructure(
  candles: CandleWithIndicators[],
  idx: number,
): TopPatternResult {
  if (idx < 30 || candles.length === 0) return { triggered: false, detail: '' };

  const detectors = [detectTripleTop, detectHeadShoulderTop, detectDoubleTop];
  for (const d of detectors) {
    const m = d(candles, idx);
    if (m) {
      return {
        triggered: false,
        patternType: m.patternType,
        achievementRate: TOP_PATTERN_ACHIEVEMENT[m.patternType],
        necklinePrice: m.necklinePrice,
        breakdownThreshold: m.necklinePrice * (1 - TRUE_BREAKDOWN_PCT),
        patternTargetPrice: m.patternTargetPrice,
        // 結構失效門檻 = 頸線 ×1.03（與真跌破對稱：跌破後又反彈過頸線×3% = 假跌破）
        structureBrokenPrice: m.structureBrokenPrice * (1 + TRUE_BREAKDOWN_PCT),
        pivots: m.pivots,
        detail: `結構偵測：${getTopPatternName(m.patternType)}`,
      };
    }
  }
  return { triggered: false, detail: '無頂部型態結構' };
}

function makeTopResult(match: TopPatternMatch, closePrice: number): TopPatternResult {
  const breakdownThreshold = match.necklinePrice * (1 - TRUE_BREAKDOWN_PCT);
  // 結構失效門檻 = 頸線 ×1.03（與真跌破對稱）
  const structureBrokenThreshold = match.structureBrokenPrice * (1 + TRUE_BREAKDOWN_PCT);

  // 結構成立但未過真跌破 / 已達目標：triggered=false，但仍回傳 pivots+頸線等供走圖視覺化
  const structureOnly = (detail: string): TopPatternResult => ({
    triggered: false,
    patternType: match.patternType,
    achievementRate: TOP_PATTERN_ACHIEVEMENT[match.patternType],
    necklinePrice: match.necklinePrice,
    breakdownThreshold,
    patternTargetPrice: match.patternTargetPrice,
    structureBrokenPrice: structureBrokenThreshold,
    pivots: match.pivots,
    detail,
  });

  // 真跌破檢查：close ≤ neckline × 0.97
  if (closePrice > breakdownThreshold) {
    return structureOnly('頂部型態結構成立但未過 ×3% 真跌破');
  }

  // 2026-05-10 補：對稱底部 makeResult — close 已下到 target × 1.03 視為「型態已達目標」
  // 跌破出場警示「已完成」，再警示沒意義（避免 1301.TW close=48.55 但 target=48.6 已達標仍警示）
  if (closePrice <= match.patternTargetPrice * 1.03) {
    return structureOnly('頂部型態已接近/超過目標價，視為已達標非新警示');
  }

  return {
    triggered: true,
    patternType: match.patternType,
    achievementRate: TOP_PATTERN_ACHIEVEMENT[match.patternType],
    necklinePrice: match.necklinePrice,
    breakdownThreshold,
    patternTargetPrice: match.patternTargetPrice,
    structureBrokenPrice: structureBrokenThreshold,
    pivots: match.pivots,
    detail: `${getTopPatternName(match.patternType)}（達成率 ${TOP_PATTERN_ACHIEVEMENT[match.patternType]}%${TOP_PATTERN_ACHIEVEMENT[match.patternType] < 50 ? ' ⚠️ 低達成率' : ''}+跌破頸線 ${match.necklinePrice.toFixed(2)}×3%）`,
  };
}

// ── 三重頂 ────────────────────────────────────────────────────────────────

const TRIPLE_TOP_TOLERANCE_PCT = 0.05;

function detectTripleTop(
  candles: CandleWithIndicators[],
  idx: number,
): TopPatternMatch | null {
  const pivots = findPivots(candles, idx, 12, false, 0.005);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 3);
  const allLows = pivots.filter(p => p.type === 'low');

  if (highs.length < 3 || allLows.length < 2) return null;

  const [high1, high2, high3] = highs;
  const minHigh = Math.min(high1.price, high2.price, high3.price);
  const maxHigh = Math.max(high1.price, high2.price, high3.price);
  if ((maxHigh - minHigh) / minHigh > TRIPLE_TOP_TOLERANCE_PCT) return null;

  const interiorLows = allLows.filter(
    (l) => l.index > high3.index && l.index < high1.index,
  );
  if (interiorLows.length < 2) return null;

  // 頸線 = 兩內部低點中較高（保守取較高 — 跌破時需要破此價）
  const necklinePrice = Math.max(interiorLows[0].price, interiorLows[1].price);

  // 目標價 = 頸線 - (最高點 - 頸線)
  const highestHigh = Math.max(high1.price, high2.price, high3.price);
  const patternTargetPrice = necklinePrice - (highestHigh - necklinePrice);

  // 結構失效 = 再過頸線（書本標準：跌破後反彈過頸線則結構破壞，假跌破）
  const structureBrokenPrice = necklinePrice;

  // pivots 順序：3 highs (新→舊) + 2 interior lows（標籤 H1/H2/H3 + L1/L2）
  return {
    patternType: 'triple-top',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
    pivots: [high1, high2, high3, interiorLows[0], interiorLows[1]],
  };
}

// ── 頭肩頂 ────────────────────────────────────────────────────────────────

function detectHeadShoulderTop(
  candles: CandleWithIndicators[],
  idx: number,
): TopPatternMatch | null {
  const pivots = findPivots(candles, idx, 10, false, 0.005);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 3);
  const allLows = pivots.filter(p => p.type === 'low');

  if (highs.length < 3 || allLows.length < 2) return null;

  // 由新到舊：right shoulder, head, left shoulder
  const [rightShoulder, head, leftShoulder] = highs;

  // 頭部高於兩肩
  if (head.price <= rightShoulder.price || head.price <= leftShoulder.price) return null;

  // 兩肩價位接近（差 < 10%）
  const shoulderDiff = Math.abs(rightShoulder.price - leftShoulder.price);
  const shoulderAvg = (rightShoulder.price + leftShoulder.price) / 2;
  if (shoulderDiff / shoulderAvg > 0.10) return null;

  // 頸線：三高點之間的兩內部低點
  const interiorLows = allLows.filter(
    (l) => l.index > leftShoulder.index && l.index < rightShoulder.index,
  );
  if (interiorLows.length < 2) return null;

  // 頸線 = 兩內部低點中較高（跌破時需要破此價）
  const necklinePrice = Math.max(interiorLows[0].price, interiorLows[1].price);

  // 目標價 = 頸線 - (頭部最高 - 頸線)
  const patternTargetPrice = necklinePrice - (head.price - necklinePrice);

  // 結構失效 = 再過頸線（書本標準）
  const structureBrokenPrice = necklinePrice;

  // pivots 順序：RS / Head / LS + 2 interior necks（標籤 RS/H/LS + RN/LN）
  return {
    patternType: 'head-shoulder-top',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
    pivots: [rightShoulder, head, leftShoulder, interiorLows[0], interiorLows[1]],
  };
}

// ── 雙重頂 ────────────────────────────────────────────────────────────────

const DOUBLE_TOP_TOLERANCE_PCT = 0.05;

function detectDoubleTop(
  candles: CandleWithIndicators[],
  idx: number,
): TopPatternMatch | null {
  const pivots = findPivots(candles, idx, 10, false, 0.005);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const allLows = pivots.filter(p => p.type === 'low');

  if (highs.length < 2) return null;

  const [high1, high2] = highs;
  const minHigh = Math.min(high1.price, high2.price);
  const maxHigh = Math.max(high1.price, high2.price);
  if ((maxHigh - minHigh) / minHigh > DOUBLE_TOP_TOLERANCE_PCT) return null;

  const interiorLows = allLows.filter((l) => l.index > high2.index && l.index < high1.index);
  if (interiorLows.length < 1) return null;

  // 頸線 = 中間最低點（雙頂跌破頸線後做空）
  const necklinePrice = Math.min(...interiorLows.map((l) => l.price));

  // 目標價 = 頸線 - (兩頂最高 - 頸線)
  const highestHigh = Math.max(high1.price, high2.price);
  const patternTargetPrice = necklinePrice - (highestHigh - necklinePrice);

  // 結構失效 = 再過頸線（書本標準）
  const structureBrokenPrice = necklinePrice;

  // pivots 順序：2 highs (新→舊) + 中間最低低點（標籤 H1/H2 + L）
  const valleyLow = interiorLows.find(l => l.price === necklinePrice) ?? interiorLows[0];
  return {
    patternType: 'double-top',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
    pivots: [high1, high2, valleyLow],
  };
}
