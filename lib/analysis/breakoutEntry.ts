/**
 * 突破進場偵測（B 買法）— 合併盤整突破 + 回後買上漲
 *
 * 朱家泓《做對5個實戰步驟》p.40：
 *   位置 1 盤整突破：前置盤整（<15% 區間）+ 突破上頸線 + 量 + 紅K
 *   位置 2 回後買上漲：多頭回檔不破前低 + 再突破前波高 + 量 + 紅K
 *
 * 共同扳機：大量長紅 K 突破前高
 * 差異：前置狀態（盤整 vs 多頭回檔）+ 停損位置
 *
 * Phase 3（2026-04-20 並列買法架構）
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
// 朱家泓原文（《做對5步驟》p.40 位置 2 + Smart 月刊「回後買上漲」口訣）：
//   前提：週線多頭確認 → 日線回檔 → 再度上漲第 1 根紅K 進場
//   止跌確認訊號（書本明確列出）：
//     1. 站上 MA5（昨日 close 在 MA5 下或附近，今日 close > MA5）
//     2. KD 金叉向上（prevK ≤ prevD && K > D）
//     3. 紅K + 量 ≥ 前日 × 1.3（爆量紅K）
//
// 前版用「回檔 3-15 天」「幅度 ≥ 3%」為實作自創，已移除以對齊書本明確扳機。

interface PullbackState {
  isPullback: boolean;
  prevSwingLow: number;       // 回檔低點（停損參考）
  pullbackDays: number;       // 回檔持續天數（info only）
  ma5Reclaim: boolean;        // 今日站上 MA5
  kdGolden: boolean;          // 今日 KD 金叉
  pullbackLowClose: number;   // 回檔低點收盤（UI 顯示）
}

/**
 * 回後買上漲判定（朱家泓書本版，無時間限制）
 * 書本：回後買上漲沒有時間限制，但必須是多頭趨勢（頭頭高底底高）
 * 1. 多頭趨勢（detectTrend === '多頭'）
 * 2. 今日站上 MA5（收盤 > MA5）
 * 3. 今日 KD 金叉向上（隱含「從回檔低檔上來」）
 * 注：紅K + 量由主流程 checkCommonTrigger 處理
 */
function detectPullback(candles: CandleWithIndicators[], idx: number): PullbackState {
  const empty: PullbackState = {
    isPullback: false, prevSwingLow: 0, pullbackDays: 0,
    ma5Reclaim: false, kdGolden: false, pullbackLowClose: 0,
  };
  if (idx < 21) return empty;

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (c.ma5 == null || prev == null) return empty;

  // ── 1. 趨勢多頭（頭頭高底底高） ──
  if (detectTrend(candles, idx) !== '多頭') return empty;

  // ── 2. 今日站上 MA5 ──
  const ma5Reclaim = c.close > c.ma5;
  if (!ma5Reclaim) return empty;

  // ── 3. 今日 KD 金叉向上 ──
  const kdGolden =
    c.kdK != null && c.kdD != null && prev.kdK != null && prev.kdD != null &&
    prev.kdK <= prev.kdD && c.kdK > c.kdD;
  if (!kdGolden) return empty;

  // 最近低點（info，用於停損參考）
  const pivots = findPivots(candles, idx - 1, 8);
  const lastLow = pivots.find(p => p.type === 'low');
  const prevSwingLow = lastLow?.price ?? c.low;

  return {
    isPullback: true,
    prevSwingLow,
    pullbackDays: 0, // info-only，無時間限制
    ma5Reclaim,
    kdGolden,
    pullbackLowClose: prevSwingLow,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────────────────────

export function detectBreakoutEntry(
  candles: CandleWithIndicators[],
  idx: number,
): BreakoutEntryResult | null {
  if (idx < 21) return null;

  // 先試盤整突破
  const consol = detectConsolidation(candles, idx);
  if (consol.isConsolidation) {
    const trig = checkCommonTrigger(candles, idx, consol.high);
    if (trig.pass) {
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
  }

  // 再試回後買上漲（書本版：站上 MA5 + KD 金叉 + 紅K + 量×1.3 + 突破前一根K 高點）
  const pb = detectPullback(candles, idx);
  if (pb.isPullback) {
    const c = candles[idx];
    const prev = candles[idx - 1];
    if (!prev || prev.volume <= 0 || c.open <= 0) return null;
    // 紅K
    if (c.close <= c.open) return null;
    // 實體 ≥ 2%
    const bodyPct = (c.close - c.open) / c.open * 100;
    if (bodyPct < 2) return null;
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
      detail: `回後買上漲（多頭+站上MA5+KD金叉+紅K實體${bodyPct.toFixed(2)}%+量×${volumeRatio.toFixed(2)}+突破前K高${prev.high.toFixed(1)}）`,
    };
  }

  return null;
}
