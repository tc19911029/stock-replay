/**
 * Provisional 3 天驗證管理（v12 Phase 1.7）
 *
 * 適用：型態類訊號 K（K 線橫盤突破）/ D（一字底）
 *
 * 議題 75：K/D provisional 寫 scan record metadata（不寫 LockWatch；F/N 才寫 LockWatch）
 * 議題 24：triggerPrice 觸發日鎖定（3 天驗證期不重算）
 * 議題 86：3 天 = 3 個交易日（不算週末/國定假日）
 * 議題 7：30 天內連續撤銷 ≥ 2 次 → 「訊號不穩」標籤
 * 議題 94：撤銷三條件（close < triggerPrice / detectTrend 翻空頭 / 結構失效）
 *
 * 書本依據：抓飆股 p.338 真突破第 3 條「停留 3 天」⭐
 *
 * 注意：v12 議題 6 嚴格只套 K/D（25 型態之 #2 一字底 + 寶典橫盤型態），
 *       不套 B/P/C/J/L/M（非型態）/ E（缺口）/ F/N/O（轉折軌走 LockWatch）。
 */

import type { CandleWithIndicators } from '../../types';

import { tradingDaysBetween } from '../utils/tradingDay';
import { detectTrend } from '../analysis/trendAnalysis';
import type { ProvisionalEvent, ProvisionalState } from './types';
import type { MarketId } from './types';

const PROVISIONAL_DAYS = 3;
const REVOCATION_TRACK_WINDOW_DAYS = 30;

/**
 * 觸發日建立 provisional state
 */
export function createProvisional(args: {
  triggerPrice: number;
  triggeredDate: string;
}): ProvisionalState {
  return {
    triggerPrice: args.triggerPrice,
    daysRemaining: PROVISIONAL_DAYS,
    status: 'provisional',
    revocationCount: 0,
    history: [
      {
        date: args.triggeredDate,
        event: 'triggered',
        detail: `triggerPrice=${args.triggerPrice.toFixed(2)}`,
      },
    ],
  };
}

export interface ProvisionalUpdateResult {
  changed: boolean;
  state: ProvisionalState;
  reason?: string;
}

/**
 * 每日 cron 維護 provisional（議題 94 三條件 + 86 交易日計算）
 *
 * @param state 既有 provisional state
 * @param triggeredDate 觸發日 ISO
 * @param today 今日 ISO
 * @param candles 該股票最新 K 線
 * @param market 市場（用於交易日計算）
 */
export function updateProvisional(
  state: ProvisionalState,
  triggeredDate: string,
  today: string,
  candles: ReadonlyArray<CandleWithIndicators>,
  market: MarketId = 'TW',
): ProvisionalUpdateResult {
  // 已撤銷或已升級不再處理
  if (state.status !== 'provisional') {
    return { changed: false, state };
  }

  if (candles.length === 0) {
    return { changed: false, state };
  }

  const lastIdx = candles.length - 1;
  const c = candles[lastIdx];
  const updated: ProvisionalState = {
    ...state,
    history: [...state.history],
  };

  // ── 撤銷條件 1：close < triggerPrice ──
  if (c.close < state.triggerPrice) {
    updated.status = 'revoked';
    updated.daysRemaining = 0;
    updated.revocationCount = state.revocationCount + 1;
    addEvent(
      updated,
      today,
      'revoked-price',
      `close=${c.close.toFixed(2)} < triggerPrice=${state.triggerPrice.toFixed(2)}`,
    );
    return { changed: true, state: updated, reason: 'price-below-trigger' };
  }

  // ── 撤銷條件 2：detectTrend 翻空頭 ──
  const trendNow = detectTrend(candles as CandleWithIndicators[], lastIdx);
  if (trendNow === '空頭') {
    updated.status = 'revoked';
    updated.daysRemaining = 0;
    updated.revocationCount = state.revocationCount + 1;
    addEvent(updated, today, 'revoked-trend', 'detectTrend 翻空頭');
    return { changed: true, state: updated, reason: 'trend-bearish' };
  }

  // ── 倒數天數（議題 86 用交易日，跨週末算同一個 N 天）──
  const elapsedTradingDays = tradingDaysBetween(triggeredDate, today, market);
  const daysRemaining = Math.max(
    0,
    PROVISIONAL_DAYS - elapsedTradingDays,
  ) as 0 | 1 | 2 | 3;

  // ── 升級條件：3 天驗證過（沒撤銷 + daysRemaining = 0）──
  if (daysRemaining === 0) {
    updated.status = 'confirmed';
    updated.daysRemaining = 0;
    addEvent(updated, today, 'confirmed', '3 天驗證過，升級 confirmed');
    return { changed: true, state: updated };
  }

  // 仍在 provisional 期間
  if (daysRemaining !== state.daysRemaining) {
    updated.daysRemaining = daysRemaining;
    return { changed: true, state: updated };
  }

  return { changed: false, state: updated };
}

/**
 * 撤銷後重觸發 → 視為新 provisional 訊號
 *
 * 議題 7：30 天內連續撤銷 ≥ 2 次 → 「訊號不穩」標籤
 */
export function reTriggerProvisional(
  oldState: ProvisionalState,
  newTriggerPrice: number,
  today: string,
): ProvisionalState {
  // 計算 30 天內撤銷次數
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - REVOCATION_TRACK_WINDOW_DAYS);

  const recentRevocations = oldState.history.filter(
    h =>
      h.event.startsWith('revoked') &&
      new Date(h.date) >= cutoff,
  );
  const revocationCount = recentRevocations.length;

  return {
    triggerPrice: newTriggerPrice,
    daysRemaining: PROVISIONAL_DAYS,
    status: 'provisional',
    revocationCount,
    history: [
      ...oldState.history,
      {
        date: today,
        event: 'triggered',
        detail: `重觸發；30 天內已撤銷 ${revocationCount} 次`,
      },
    ],
  };
}

/**
 * 是否標「訊號不穩」（議題 7：30 天內連續撤銷 ≥ 2 次）
 */
export function isUnstableSignal(state: ProvisionalState): boolean {
  return state.revocationCount >= 2;
}

// ── 內部 helper ──────────────────────────────────────────────────────────

function addEvent(
  state: ProvisionalState,
  date: string,
  event: ProvisionalEvent['event'],
  detail?: string,
): void {
  state.history.push({ date, event, detail });
}
