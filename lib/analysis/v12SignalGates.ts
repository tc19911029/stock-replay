/**
 * v12 訊號 Gate Helpers（v12 Phase 1.3）
 *
 * 包裝既有 detector，加 v12 鎖定的書本 gate（不修既有 code，向後相容）。
 *
 * v12 議題對應：
 * - 議題 47 / 55 / 99：B/P/C/L/M 加「最近 1 pivot high + 1 pivot low」gate
 * - 議題 73 / 79：J/K/E 不套 pivot gate（自帶結構驗證）
 * - 議題 B：B 訊號加「不破前低」+「不破 MA20」gate（書本 p.694 明寫）
 *
 * 書本依據：
 * - 寶典 p.692 第 2 位置 / p.694 第 4 位置「上漲一波後」前提
 * - 純書本「最近的一波」（議題 99：不限翻多 T）
 */

import type { CandleWithIndicators } from '@/types';

import { findPivots } from './trendAnalysis';

// ── 議題 47/55/99：最近 pivot pair gate ──────────────────────────────────

export interface PivotGateResult {
  /** 是否過 gate（最近 1 pivot high + 1 pivot low 已成立）*/
  passed: boolean;
  /** 最近 pivot high index（找到才有）*/
  recentPivotHighIndex?: number;
  /** 最近 pivot high price */
  recentPivotHighPrice?: number;
  /** 最近 pivot low index */
  recentPivotLowIndex?: number;
  /** 最近 pivot low price */
  recentPivotLowPrice?: number;
  /** UI 顯示用（gate 不過時的等待文字）*/
  waitingMessage?: string;
}

/**
 * v12 議題 47/55/99：「上漲一波後」結構性 gate
 *
 * 套用於：B / P / C / L / M（多頭軌單 K 訊號）
 * 不套用：E（缺口）/ J（ABC 自帶 4 pivot）/ K（橫盤自帶 ≥ 3 根橫盤）
 *
 * 純書本「最近的一波」 = 最近的 1 個 pivot high + 1 個 pivot low（不限翻多 T）。
 *
 * @param candles 完整 K 線
 * @param index 查詢時點
 * @returns gate 結果 + UI 提示
 */
export function checkPivotPairGate(
  candles: ReadonlyArray<CandleWithIndicators>,
  index: number,
): PivotGateResult {
  if (index < 20 || candles.length === 0) {
    return {
      passed: false,
      waitingMessage: '⏳ 資料不足，等待 pivot 結構建立',
    };
  }

  const pivots = findPivots(candles as CandleWithIndicators[], index, 8, false);
  const highs = pivots.filter(p => p.type === 'high');
  const lows = pivots.filter(p => p.type === 'low');

  if (highs.length === 0 || lows.length === 0) {
    return {
      passed: false,
      waitingMessage: '⏳ 等待第 1 次回檔波（多頭結構建立中）',
    };
  }

  return {
    passed: true,
    recentPivotHighIndex: highs[0].index,
    recentPivotHighPrice: highs[0].price,
    recentPivotLowIndex: lows[0].index,
    recentPivotLowPrice: lows[0].price,
  };
}

// ── 議題 B：B 訊號「不破前低 + 不破 MA20」gate ──────────────────────────────

export interface PullbackIntegrityResult {
  /** 是否過 gate（回檔期間沒破前低 + 沒破 MA20）*/
  passed: boolean;
  /** 回檔期間最低點 */
  pullbackLow?: number;
  /** 前波低點（pivot low）*/
  prevSwingLow?: number;
  /** 回檔期間 MA20 最低值 */
  ma20Min?: number;
  /** 失敗原因（passed=false 時填）*/
  failReason?: 'broke-prev-low' | 'broke-ma20' | 'no-pivot';
  /** UI 失敗提示 */
  failMessage?: string;
}

/**
 * v12 議題 B：B 回後買上漲「不破前低 + 不破 MA20」gate
 *
 * 書本依據：寶典 p.694 第 4 位置「等上漲」原文：
 *   「多頭上漲一波後處在下跌回檔，**拉回不破前低，不破月線（MA20）**，上漲時做多」
 *
 * 既有 detectBreakoutEntry (B) 沒擋這兩條件，v12 必加。
 *
 * @param candles 完整 K 線
 * @param index 進場日 index
 * @param pullbackStartIdx 回檔起始 index（可由 detectPullback 取得）
 */
export function checkPullbackIntegrity(
  candles: ReadonlyArray<CandleWithIndicators>,
  index: number,
  pullbackStartIdx: number,
): PullbackIntegrityResult {
  if (index < 20 || pullbackStartIdx < 0 || pullbackStartIdx >= index) {
    return {
      passed: false,
      failReason: 'no-pivot',
      failMessage: '⚠️ 回檔起點無效',
    };
  }

  // 找前波低點（pullback 之前最近的 pivot low）
  const pivotsBeforePullback = findPivots(
    candles as CandleWithIndicators[],
    pullbackStartIdx,
    8,
    false,
  );
  const prevLows = pivotsBeforePullback.filter(p => p.type === 'low');
  if (prevLows.length === 0) {
    return {
      passed: false,
      failReason: 'no-pivot',
      failMessage: '⚠️ 回檔前找不到 pivot low（無「前低」可比較）',
    };
  }
  const prevSwingLow = prevLows[0].price;

  // 計算回檔期間最低點 + MA20 最低值
  let pullbackLow = Infinity;
  let ma20Min = Infinity;
  for (let i = pullbackStartIdx; i <= index; i++) {
    const c = candles[i];
    if (!c) continue;
    if (c.low < pullbackLow) pullbackLow = c.low;
    if (c.ma20 != null && c.ma20 < ma20Min) ma20Min = c.ma20;
  }

  // gate 1：不破前低（pullbackLow ≥ prevSwingLow）
  if (pullbackLow < prevSwingLow) {
    return {
      passed: false,
      pullbackLow,
      prevSwingLow,
      failReason: 'broke-prev-low',
      failMessage: `⚠️ 回檔已破前低（${pullbackLow.toFixed(2)} < ${prevSwingLow.toFixed(2)}），不算「回後買上漲」`,
    };
  }

  // gate 2：不破 MA20（pullbackLow ≥ 回檔期間 MA20 最低值）
  // 注意：寶典原文「不破月線（MA20）」 = close 不跌破 MA20，但實務可用 low 比較更嚴
  if (ma20Min !== Infinity && pullbackLow < ma20Min) {
    return {
      passed: false,
      pullbackLow,
      ma20Min,
      failReason: 'broke-ma20',
      failMessage: `⚠️ 回檔已跌破 MA20（${pullbackLow.toFixed(2)} < ${ma20Min.toFixed(2)}），不算「回後買上漲」`,
    };
  }

  return { passed: true, pullbackLow, prevSwingLow, ma20Min };
}
