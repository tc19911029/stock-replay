/**
 * Winner Patterns cache — precomputes 33 winner patterns across all candles.
 *
 * Avoids 33-pattern recomputation on every chart navigation (走圖 setIndex)。
 * 同 signalCache 的 module-level cache pattern：載新標的時清空再 precompute。
 */

import { CandleWithIndicators } from '@/types';
import { evaluateWinnerPatterns, WinnerPatternResult } from '@/lib/rules/winnerPatternRules';

const EMPTY_RESULT: WinnerPatternResult = {
  bullishPatterns: [],
  bearishPatterns: [],
  compositeAdjust: 0,
};

let _cache: (WinnerPatternResult | null)[] = [];
let _candlesRef: CandleWithIndicators[] | null = null;

export function getWinnerPatternsAt(index: number): WinnerPatternResult | null {
  if (index < 0 || index >= _cache.length) return null;
  return _cache[index];
}

/**
 * Precompute all 33 patterns for every candle.
 * Called on stock load (和 precomputeMarkers 同個生命週期)。
 */
export function precomputeWinnerPatterns(allCandles: CandleWithIndicators[]): void {
  _candlesRef = allCandles;
  _cache = new Array(allCandles.length);
  for (let i = 0; i < allCandles.length; i++) {
    if (i < 5) {
      _cache[i] = null;
    } else {
      try {
        _cache[i] = evaluateWinnerPatterns(allCandles, i);
      } catch {
        _cache[i] = EMPTY_RESULT;
      }
    }
  }
}

/**
 * Reset cache (在 stock 切換之前呼叫，避免短暫顯示舊資料)。
 */
export function clearWinnerPatternsCache(): void {
  _cache = [];
  _candlesRef = null;
}

/**
 * 確認 cache 是否對應目前 allCandles ref。若否，重新 precompute。
 */
export function ensureWinnerPatternsCache(allCandles: CandleWithIndicators[]): void {
  if (_candlesRef !== allCandles) {
    precomputeWinnerPatterns(allCandles);
  }
}
