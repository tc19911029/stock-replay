/**
 * 突破進場偵測
 *
 * B 買法：回後買上漲（detectBreakoutEntry，pullback_buy subType）
 * C 買法：盤整突破（detectConsolidationBreakout，consolidation_breakout subType）
 *
 * 朱家泓《做對5個實戰步驟》p.40：
 *   位置 1 盤整突破（C）：前置盤整（<15% 區間）+ 突破上頸線 + 量 + 紅K
 *   位置 2 回後買上漲（B）：多頭回檔不破前低 + 再突破前波高 + 量 + 紅K
 *
 * 共同扳機：大量長紅 K 突破前高
 * 差異：前置狀態（盤整 vs 多頭回檔）+ 停損位置
 *
 * Phase 3（2026-04-20 並列買法架構）
 * 2026-04-21 拆分：B=回後買上漲、C=盤整突破，各自獨立 export
 */

import type { CandleWithIndicators } from '@/types';
import { detectTrend, findPivots } from '@/lib/analysis/trendAnalysis';

export type BreakoutSubType = 'consolidation_breakout' | 'pullback_buy';

export interface BreakoutEntryResult {
  isBreakout: boolean;
  subType: BreakoutSubType;
  breakoutPrice: number;      // 被突破的前高
  bodyPct: number;
  volumeRatio: number;
  /** subType=consolidation_breakout 時的盤整低點（停損參考） */
  consolidationLow?: number;
  /** subType=pullback_buy 時的前波低點（停損參考） */
  prevSwingLow?: number;
  /** 盤整天數或回檔天數 */
  preEntryDays: number;
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 輔助：共同扳機判定
// ─────────────────────────────────────────────────────────────────────────────

interface TriggerCheck {
  pass: boolean;
  bodyPct: number;
  volumeRatio: number;
  breakoutPrice: number;
}

function checkCommonTrigger(
  candles: CandleWithIndicators[],
  idx: number,
  breakoutPrice: number,
): TriggerCheck {
  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev || prev.volume <= 0 || c.open <= 0) {
    return { pass: false, bodyPct: 0, volumeRatio: 0, breakoutPrice };
  }
  // 紅 K
  if (c.close <= c.open) return { pass: false, bodyPct: 0, volumeRatio: 0, breakoutPrice };
  // 實體 ≥ 2.5%
  const bodyPct = (c.close - c.open) / c.open * 100;
  if (bodyPct < 2.5) return { pass: false, bodyPct, volumeRatio: 0, breakoutPrice };
  // 量比 ≥ 1.3
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < 1.3) return { pass: false, bodyPct, volumeRatio, breakoutPrice };
  // 收盤突破前高
  if (c.close <= breakoutPrice) return { pass: false, bodyPct, volumeRatio, breakoutPrice };
  return { pass: true, bodyPct, volumeRatio, breakoutPrice };
}

// ─────────────────────────────────────────────────────────────────────────────
// subType 1：盤整突破
// ─────────────────────────────────────────────────────────────────────────────

interface ConsolidationState {
  isConsolidation: boolean;
  high: number;
  low: number;
  days: number;
}

/**
 * 判斷 idx-1 之前是否為盤整（書本定義）：
 *   盤整 = 非頭頭高底底高、也非頭頭低底底低（即 detectTrend === '盤整'）
 *   上頸線 = findPivots 最近兩個頭連線（今日延伸值）
 */
function detectConsolidation(candles: CandleWithIndicators[], idx: number): ConsolidationState {
  if (idx < 21) return { isConsolidation: false, high: 0, low: 0, days: 0 };

  // 用 detectTrend 判定是否盤整（書本原意）
  const trend = detectTrend(candles, idx - 1);
  if (trend !== '盤整') return { isConsolidation: false, high: 0, low: 0, days: 0 };

  // 上頸線 = 最近兩個頭 pivots 連線在今日延伸值
  const pivots = findPivots(candles, idx - 1, 8);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const lows  = pivots.filter(p => p.type === 'low').slice(0, 2);
  if (highs.length < 2) return { isConsolidation: false, high: 0, low: 0, days: 0 };

  const [lh, eh] = highs;
  const hSlope = (lh.price - eh.price) / (lh.index - eh.index);
  const upperNecklineToday = lh.price + hSlope * (idx - lh.index);

  const lowPrice = lows.length >= 2 ? Math.min(lows[0].price, lows[1].price) : 0;

  return {
    isConsolidation: true,
    high: upperNecklineToday,
    low: lowPrice,
    days: idx - eh.index,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// subType 2：回後買上漲（朱家泓書本版）
// ─────────────────────────────────────────────────────────────────────────────
//
// 寶典 p.238-244 波浪型態戰法：底底高 + 收盤站上 MA5 → 買進
// 《做對5步驟》位置 2：多頭回檔不破前低，再大量長紅突破前高
//
// 前置條件（用戶 2026-04-22 校正）：
//   1. 多頭趨勢（detectTrend === '多頭'）— 頭頭高底底高，等同「沒跌破前底」
//   2. 昨日 close < MA5（昨日仍在 MA5 之下，代表還在回檔中）
//   3. 今日 close > MA5（今日才剛漲過 MA5，止跌反攻）
// 扳機（主流程）：紅K 實體 ≥ 2.5% + 量 ≥ 1.3x + 收盤突破前K高

interface PullbackState {
  isPullback: boolean;
  prevSwingLow: number;       // 回檔低點（停損參考）
  pullbackDays: number;       // 回檔連續天數（info only）
  ma5Reclaim: boolean;        // 今日站上 MA5
  pullbackLowClose: number;   // 回檔期最低收盤
}

function detectPullback(candles: CandleWithIndicators[], idx: number): PullbackState {
  const empty: PullbackState = {
    isPullback: false, prevSwingLow: 0, pullbackDays: 0,
    ma5Reclaim: false, pullbackLowClose: 0,
  };
  if (idx < 21) return empty;

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (c.ma5 == null || !prev || prev.ma5 == null) return empty;

  // ── 1. 趨勢多頭（頭頭高底底高 = 沒跌破前底） ──
  if (detectTrend(candles, idx) !== '多頭') return empty;

  // ── 2. 昨日 close < MA5（昨日仍在 MA5 之下） ──
  if (prev.close >= prev.ma5) return empty;

  // ── 3. 今日 close > MA5（今天才漲過 MA5） ──
  if (c.close <= c.ma5) return empty;

  // 回檔連續天數＋最低收盤（往回找連續 close<MA5 的區段，info only）
  let pullbackLowClose = prev.close;
  let pullbackDays = 0;
  for (let i = idx - 1; i >= Math.max(0, idx - 20); i--) {
    const bar = candles[i];
    if (bar.ma5 == null || bar.close >= bar.ma5) break;
    pullbackLowClose = Math.min(pullbackLowClose, bar.close);
    pullbackDays++;
  }

  const pivots = findPivots(candles, idx - 1, 8);
  const lastLow = pivots.find(p => p.type === 'low');
  const prevSwingLow = lastLow?.price ?? c.low;

  return {
    isPullback: true,
    prevSwingLow,
    pullbackDays,
    ma5Reclaim: true,
    pullbackLowClose,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// C 買法：盤整突破（獨立 export）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 盤整突破偵測（C 買法）
 *
 * 《做對5步驟》位置 1：前置盤整（detectTrend==='盤整'）+ 大量長紅突破上頸線
 * 只回傳 consolidation_breakout subType。
 */
export function detectConsolidationBreakout(
  candles: CandleWithIndicators[],
  idx: number,
): BreakoutEntryResult | null {
  if (idx < 21) return null;

  const consol = detectConsolidation(candles, idx);
  if (!consol.isConsolidation) return null;

  const trig = checkCommonTrigger(candles, idx, consol.high);
  if (!trig.pass) return null;

  return {
    isBreakout: true,
    subType: 'consolidation_breakout',
    breakoutPrice: consol.high,
    bodyPct: trig.bodyPct,
    volumeRatio: trig.volumeRatio,
    consolidationLow: consol.low,
    preEntryDays: consol.days,
    detail: `盤整突破（${consol.days}天盤整 ${consol.low.toFixed(1)}~${consol.high.toFixed(1)}→突破+實體${trig.bodyPct.toFixed(2)}%+量×${trig.volumeRatio.toFixed(2)}）`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// B 買法：回後買上漲（主入口，只做 pullback_buy）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 回後買上漲偵測（B 買法）
 *
 * 《做對5步驟》位置 2：多頭回檔不破前低 + 昨日仍在MA5之下 + 今日站回MA5 + 大量長紅突破前K高
 * 只回傳 pullback_buy subType。
 */
export function detectBreakoutEntry(
  candles: CandleWithIndicators[],
  idx: number,
): BreakoutEntryResult | null {
  if (idx < 21) return null;

  const pb = detectPullback(candles, idx);
  if (!pb.isPullback) return null;

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!prev || prev.volume <= 0 || c.open <= 0) return null;
  // 紅K
  if (c.close <= c.open) return null;
  // 實體 ≥ 2.5%
  const bodyPct = (c.close - c.open) / c.open * 100;
  if (bodyPct < 2.5) return null;
  // 量 ≥ 前日 × 1.3
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < 1.3) return null;
  // 今日收盤突破前一根 K 高點（書本明確扳機）
  if (c.close <= prev.high) return null;

  return {
    isBreakout: true,
    subType: 'pullback_buy',
    breakoutPrice: prev.high,
    bodyPct,
    volumeRatio,
    prevSwingLow: pb.prevSwingLow,
    preEntryDays: pb.pullbackDays,
    detail: `回後買上漲（多頭+昨日<MA5+今日站回MA5+紅K實體${bodyPct.toFixed(2)}%+量×${volumeRatio.toFixed(2)}+突破前K高${prev.high.toFixed(1)}）`,
  };
}
