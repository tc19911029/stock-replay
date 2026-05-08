/**
 * 紅 K 實體驗證（v12 議題 34 / 64 / 89）
 *
 * 書本依據：寶典 p.55「進場 K 線：價漲、量增、紅 K 實體棒 > 2%」
 * 「實體」 = K 線實體比例 = (close - open) / open ≥ 2%
 *
 * 例外處理（避免擋掉強勢飆股）：
 * - 漲停例外（議題 64）：close 達當日漲停 → 視為強紅 K
 * - 跳空高開例外（議題 89）：跳空缺口 ≥ 3% 且 close > open → 視為強紅 K
 *
 * 跳空例外的 ≥ 3% 標準與「真突破 ×3%」（抓飆股 p.338）標準一致。
 */

import type { MarketId } from '../scanner/types';
import { isLimitUp } from '../utils/limitRules';

export interface RedKCandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface RedKValidationResult {
  /** 是否符合紅 K 實體棒條件 */
  valid: boolean;
  /** 觸發原因：normal | limit-up | gap-up */
  reason: 'normal' | 'limit-up' | 'gap-up' | 'failed';
  /** 實體比例 (close - open) / open */
  bodyPct: number;
  /** 跳空缺口比例 (open - prevClose) / prevClose */
  gapPct: number;
}

/**
 * 判定 K 線是否為「有效紅 K」（實體 ≥ 2% 或漲停例外或跳空例外）
 *
 * @param kbar 當日 K 線 OHLC
 * @param prevClose 前一日 close
 * @param market 市場
 * @param symbol 股票代號
 * @returns 驗證結果
 */
export function validateRedK(
  kbar: RedKCandle,
  prevClose: number,
  market: MarketId,
  symbol: string,
): RedKValidationResult {
  const bodyPct = (kbar.close - kbar.open) / kbar.open;
  const gapPct = (kbar.open - prevClose) / prevClose;

  // 必須是紅 K（close > open），且不可有負實體
  if (kbar.close <= kbar.open) {
    return { valid: false, reason: 'failed', bodyPct, gapPct };
  }

  // 一般情況：實體 ≥ 2%
  if (bodyPct >= 0.02) {
    return { valid: true, reason: 'normal', bodyPct, gapPct };
  }

  // 漲停例外（議題 64）
  if (isLimitUp(kbar.close, prevClose, market, symbol)) {
    return { valid: true, reason: 'limit-up', bodyPct, gapPct };
  }

  // 跳空高開例外（議題 89）：跳空 ≥ 3% 且 close > open
  if (gapPct >= 0.03) {
    return { valid: true, reason: 'gap-up', bodyPct, gapPct };
  }

  return { valid: false, reason: 'failed', bodyPct, gapPct };
}

/**
 * 簡化版 boolean API
 */
export function isValidRedK(
  kbar: RedKCandle,
  prevClose: number,
  market: MarketId,
  symbol: string,
): boolean {
  return validateRedK(kbar, prevClose, market, symbol).valid;
}
