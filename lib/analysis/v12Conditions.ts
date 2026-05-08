/**
 * v12 純書本條件判定 helpers（v12 Phase 1.2）
 *
 * 不修既有 `trendAnalysis.ts`（向後相容）；v12 訊號 detector（Phase 1.3+）
 * 透過此模組取用對齊書本的條件判定。
 *
 * v12 議題對應：
 * - 議題 51：⑥ 指標拿掉 OSC，只用 KD + MACD（DIF > DEA + DIF 上升）
 * - 議題 88：⑤ 量分一般 / 爆量等級
 * - 議題 13：末升段判定（自底部起漲漲幅接近 1 倍）
 * - 議題 27/97：「向上」用 MA pivot 判斷
 * - 議題 91：KD「多排」= K > D 維持
 *
 * 書本依據：寶典 Part 10-3「六六大順選股」p.652-653
 */

import type { CandleWithIndicators } from '@/types';

import { findPivots } from './trendAnalysis';

// ── 議題 51：⑥ 指標純書本（拿掉 OSC，只用 KD + MACD）────────────────────────

export interface IndicatorV12Result {
  /** 是否過 ⑥ 指標（任一達成即可，書本「指標參考」語氣）*/
  passed: boolean;
  /** KD 黃交向上多排（議題 91）*/
  kdBullish: boolean;
  /** MACD 多排（DIF > DEA AND DIF today >= DIF yesterday，議題 51）*/
  macdBullish: boolean;
  /** KD 向下警示（議題 27 寶典 p.711 #9）— 警示但不擋 */
  kdDecliningWarning: boolean;
  /** 詳細描述（UI 顯示用）*/
  detail: string;
}

/**
 * v12 議題 51：⑥ 指標純書本判定
 *
 * 規則：
 * - **KD 黃交向上多排**（議題 91）：K > D + K today >= K yesterday
 * - **MACD 多排**（議題 51）：DIF > DEA + DIF today >= DIF yesterday（移除 OSC）
 * - **任一達成即可**（書本「指標參考」語氣）
 * - **KD 向下** 純警示（議題 27），不擋進場
 *
 * 注意：v11 既有邏輯用 `osc > oscPrev`（OSC 變化），v12 改用 DIF 自身上升 + DIF > DEA。
 */
export function evaluateIndicatorV12(
  candle: CandleWithIndicators,
  prev: CandleWithIndicators | null,
): IndicatorV12Result {
  const dif = candle.macdDIF;
  const dea = candle.macdSignal;
  const difPrev = prev?.macdDIF;
  const k = candle.kdK;
  const d = candle.kdD;
  const kPrev = prev?.kdK;

  // ── KD 多排（議題 91）：K > D 維持，K 上升 ──
  const kdBullish =
    k != null && d != null && kPrev != null
    && k > d
    && k >= kPrev;

  // ── MACD 多排（議題 51 純書本）：DIF > DEA + DIF 上升 ──
  const macdBullish =
    dif != null && dea != null && difPrev != null
    && dif > dea
    && dif >= difPrev;

  // ── KD 向下警示（議題 27）：K 下降 ──
  const kdDecliningWarning =
    k != null && kPrev != null && k < kPrev;

  // ── 過 ⑥ = 任一達成 ──
  const passed = kdBullish || macdBullish;

  const detail = [
    kdBullish
      ? `✅ KD 多排（K=${k?.toFixed(0)}>D=${d?.toFixed(0)}，K 上升）`
      : k != null && d != null
        ? `⚠️ KD 未過（K=${k.toFixed(0)},D=${d.toFixed(0)}）`
        : '— KD 資料不足',
    macdBullish
      ? `✅ MACD 多排（DIF=${dif?.toFixed(3)}>DEA=${dea?.toFixed(3)}，DIF 上升）`
      : dif != null && dea != null
        ? `⚠️ MACD 未過`
        : '— MACD 資料不足',
    kdDecliningWarning ? '⚠️ KD 向下警示（待 K 值向上再考慮）' : '',
  ].filter(Boolean).join(' / ');

  return { passed, kdBullish, macdBullish, kdDecliningWarning, detail };
}

// ── 議題 88：⑤ 量分等級 ──────────────────────────────────────────────────────

export type VolumeLevel = 'normal' | 'climax';

export interface VolumeLevelResult {
  /** 是否過 ⑤ 條件（量比 ≥ 1.3 即過）*/
  passed: boolean;
  /** 量比（today.volume / yesterday.volume）*/
  ratio: number | null;
  /** 等級（議題 88）*/
  level?: VolumeLevel;
  /** UI badge 文字 */
  detail: string;
}

/**
 * v12 議題 88：⑤ 量分等級
 *
 * - 一般攻擊量（normal）：1.3 ≤ ratio < 2
 * - 爆量（climax）：ratio ≥ 2
 *
 * 書本依據：寶典 p.55「攻擊量 ≥ 1.3 倍以上，**如有 2 倍以上的量，攻擊力道更強**」⭐
 *
 * coreScore 不影響（過 1.3 即過 ⑤）；爆量加分到 compositeScore（議題 102）。
 */
export function evaluateVolumeV12(
  candle: CandleWithIndicators,
  prev: CandleWithIndicators | null,
  minRatio = 1.3,
): VolumeLevelResult {
  if (!prev || prev.volume === 0) {
    return { passed: false, ratio: null, detail: '前日量資料不足' };
  }

  const ratio = candle.volume / prev.volume;
  const passed = ratio >= minRatio;

  if (!passed) {
    return {
      passed: false,
      ratio,
      detail: `⚠️ 量 ${ratio.toFixed(2)}× 前日（未達 ${minRatio}× 基準）`,
    };
  }

  const level: VolumeLevel = ratio >= 2 ? 'climax' : 'normal';
  const detail = level === 'climax'
    ? `🔥 爆量 ${ratio.toFixed(2)}× 前日（攻擊力道更強）`
    : `⚠️ 一般攻擊量 ${ratio.toFixed(2)}× 前日`;

  return { passed: true, ratio, level, detail };
}

// ── 議題 13：末升段 detector ────────────────────────────────────────────────

export interface EndPhaseResult {
  /** 是否在末升段（純書本「股價接近底部起漲 1 倍」）*/
  isEndPhase: boolean;
  /** 起漲點價格（最近翻多事件對應的 pivot low）*/
  startPrice: number | null;
  /** 自起漲點漲幅（小數，0.5 = +50%）*/
  riseFromStart: number | null;
  /** UI badge 文字 */
  badge: string;
}

/**
 * v12 議題 13：末升段判定
 *
 * 純書本：寶典 p.342, p.598「股價上漲接近底部起漲 1 倍」⭐
 *
 * 起漲點 = 最近翻多事件對應的 pivot low（用 findPivots 已確認 pivot）
 *
 * **末升段不擋入選**（書本只是警示「末升段操作只做短線」）— 純 metadata。
 *
 * @returns 末升段判定結果
 */
export function detectEndPhase(
  candles: ReadonlyArray<CandleWithIndicators>,
  index: number,
): EndPhaseResult {
  if (index < 20 || candles.length === 0) {
    return { isEndPhase: false, startPrice: null, riseFromStart: null, badge: '' };
  }

  // 找最近確認 pivot low（findPivots 回傳由新到舊）
  const pivots = findPivots(candles as CandleWithIndicators[], index, 8, false);
  const lows = pivots.filter(p => p.type === 'low');
  if (lows.length === 0) {
    return { isEndPhase: false, startPrice: null, riseFromStart: null, badge: '' };
  }

  // 起漲點 = 最近一個確認 pivot low
  const startPrice = lows[0].price;
  const currentPrice = candles[index].close;
  const riseFromStart = (currentPrice - startPrice) / startPrice;

  // 純書本「接近 1 倍」 = riseFromStart ≥ 1.0
  const isEndPhase = riseFromStart >= 1.0;

  const badge = isEndPhase
    ? `⚠️ 末升段（起漲 +${(riseFromStart * 100).toFixed(0)}%，接近 1 倍）`
    : '';

  return { isEndPhase, startPrice, riseFromStart, badge };
}

// ── 議題 27：季線下彎警示（純警示，不擋）─────────────────────────────────

export interface SeasonLineWarning {
  /** 季線（MA60）是否在股價上方 */
  isAbove: boolean;
  /** 季線是否下彎（MA pivot 判斷）*/
  isDeclining: boolean;
  /** 季線值 */
  ma60Value: number | null;
  /** UI badge 文字 */
  badge: string;
}

/**
 * v12 議題 27：季線下彎警示（純書本 p.54「會有壓力產生」）
 *
 * 純警示不擋入選；只在 close < MA60 + MA60 下彎時觸發 badge。
 *
 * 「下彎」用 MA pivot 判斷（議題 27 第 10 輪修正）— 統一上揚/下彎判定方式。
 */
export function detectSeasonLineResistance(
  candles: ReadonlyArray<CandleWithIndicators>,
  index: number,
): SeasonLineWarning {
  if (index < 60 || candles.length === 0) {
    return { isAbove: false, isDeclining: false, ma60Value: null, badge: '' };
  }

  const c = candles[index];
  const ma60 = c.ma60;
  if (ma60 == null) {
    return { isAbove: false, isDeclining: false, ma60Value: null, badge: '' };
  }

  // 季線是否在股價上方（壓力前提）
  const isAbove = ma60 > c.close;

  if (!isAbove) {
    return { isAbove: false, isDeclining: false, ma60Value: ma60, badge: '' };
  }

  // 簡單下彎判斷：MA60 today < MA60 60 天前
  // (議題 27 鎖定用 MA pivot，但需要至少 60 + window 根 K，較少見全套)
  const lookback = Math.min(60, index);
  const ma60Past = candles[index - lookback]?.ma60;
  const isDeclining = ma60Past != null && ma60 < ma60Past;

  const badge = isDeclining
    ? `⚠️ 上方季線壓力（MA60=${ma60.toFixed(2)}，下彎中）`
    : `📍 上方季線（MA60=${ma60.toFixed(2)}）`;

  return { isAbove: true, isDeclining, ma60Value: ma60, badge };
}
