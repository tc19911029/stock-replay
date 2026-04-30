/**
 * OHLCV data quality validation.
 *
 * Detects anomalous candle data before it enters the analysis pipeline.
 * Invalid candles can cause false signals, broken charts, and wrong backtest results.
 */

import type { CandleWithIndicators } from '@/types';
import { tradingDaysBetween } from '@/lib/utils/tradingDay';

interface ValidationResult {
  /** Cleaned candles with anomalies removed */
  candles: CandleWithIndicators[];
  /** Number of candles removed */
  removed: number;
  /** Descriptions of issues found */
  issues: string[];
}

/**
 * Validate and clean OHLCV data.
 *
 * Checks for:
 * 1. high < low (impossible — data corruption)
 * 2. Zero or negative prices
 * 3. Duplicate dates
 * 4. Out-of-order dates
 * 5. Extreme price jumps (>50% single-day) as warnings
 *
 * market: CN allows close > high / close < low — closing auction (收盤集合競價)
 *   can produce a price outside the main session's high/low range.
 *   TW adjusted prices can similarly produce close < low (ex-rights artifact).
 *   Both are treated as warnings rather than hard errors when market is provided.
 */
export function validateCandles(
  raw: CandleWithIndicators[],
  market?: 'TW' | 'CN',
): ValidationResult {
  const issues: string[] = [];
  let removed = 0;

  // Pass 1: Remove clearly invalid candles
  const valid = raw.filter((c, i) => {
    // Check for missing essential fields
    if (!c.date || c.open == null || c.high == null || c.low == null || c.close == null) {
      issues.push(`[${i}] 缺少必要欄位 (date=${c.date})`);
      removed++;
      return false;
    }

    // Check high >= low
    if (c.high < c.low) {
      issues.push(`[${c.date}] high (${c.high}) < low (${c.low})`);
      removed++;
      return false;
    }

    // Check for zero/negative prices
    if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) {
      issues.push(`[${c.date}] 零或負價格`);
      removed++;
      return false;
    }

    // Check OHLC consistency (open, close should be within [low, high])
    // Exception: CN closing auction can produce close outside main-session high/low;
    //            TW adjusted prices can produce close < low on ex-rights days.
    //            Treat these as warnings (don't remove) when market is known.
    if (c.open > c.high || c.open < c.low) {
      issues.push(`[${c.date}] open 不在 high/low 範圍內: O=${c.open} H=${c.high} L=${c.low}`);
      removed++;
      return false;
    }
    if (c.close > c.high || c.close < c.low) {
      if (market) {
        issues.push(`[${c.date}] close 超出 high/low 範圍（${market} 已知現象）: C=${c.close} H=${c.high} L=${c.low}`);
        // warn only, don't remove
      } else {
        issues.push(`[${c.date}] OHLC 不一致: O=${c.open} H=${c.high} L=${c.low} C=${c.close}`);
        removed++;
        return false;
      }
    }

    return true;
  });

  // Pass 2: Deduplicate by date (keep last occurrence)
  const seen = new Map<string, number>();
  valid.forEach((c, i) => seen.set(c.date, i));
  const deduped = valid.filter((c, i) => {
    const keep = seen.get(c.date) === i;
    if (!keep) {
      issues.push(`[${c.date}] 重複日期（已移除）`);
      removed++;
    }
    return keep;
  });

  // Pass 3: Sort by date ascending
  deduped.sort((a, b) => a.date.localeCompare(b.date));

  // Pass 4: Warn about extreme price jumps (informational only, don't remove)
  for (let i = 1; i < deduped.length; i++) {
    const prev = deduped[i - 1];
    const curr = deduped[i];
    const pctChange = Math.abs((curr.close - prev.close) / prev.close);
    if (pctChange > 0.5) {
      issues.push(`[${curr.date}] 異常漲跌幅 ${(pctChange * 100).toFixed(1)}%（可能是除權息或資料錯誤）`);
    }
  }

  return { candles: deduped, removed, issues };
}

// ── Gap Detection ─────────────────────────────────────────────────────────────

export interface CandleGap {
  /** 斷層前最後一根K線日期 */
  fromDate: string;
  /** 斷層後第一根K線日期 */
  toDate: string;
  /** 兩根K線間的日曆天數 */
  calendarDays: number;
  /** 兩根K線間的交易日數（若有提供 market） */
  tradingDays?: number;
}

/**
 * 偵測 K 線資料中的大型日期斷層。
 *
 * 當提供 market 參數時，使用交易日差距判斷（排除假日），
 * 門檻 maxGapTradingDays（預設 5 個交易日）。
 * 不提供 market 時，回退到日曆天（maxGapDays 預設 10 天）。
 *
 * @param candles 已排序的K線陣列
 * @param maxGapDays 允許的最大日曆天數間隔（預設 10 天，僅在無 market 時使用）
 * @param market 市場（提供後改用交易日差距判斷）
 * @param maxGapTradingDays 允許的最大交易日間隔（預設 8 天，涵蓋國慶+春節調休）
 */
export function detectCandleGaps(
  candles: Array<{ date: string }>,
  maxGapDays = 10,
  market?: 'TW' | 'CN',
  maxGapTradingDays = 8,
): CandleGap[] {
  const gaps: CandleGap[] = [];

  // 有 market → 用交易日差距（精確排除假日）
  if (market) {
    for (let i = 1; i < candles.length; i++) {
      const prev = new Date(candles[i - 1].date + 'T12:00:00');
      const curr = new Date(candles[i].date + 'T12:00:00');
      const calendarDays = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));
      const tDays: number = tradingDaysBetween(candles[i - 1].date, candles[i].date, market);
      if (tDays > maxGapTradingDays) {
        gaps.push({
          fromDate: candles[i - 1].date,
          toDate: candles[i].date,
          calendarDays,
          tradingDays: tDays,
        });
      }
    }
    return gaps;
  }

  // 無 market → 回退到日曆天
  for (let i = 1; i < candles.length; i++) {
    const prev = new Date(candles[i - 1].date + 'T12:00:00');
    const curr = new Date(candles[i].date + 'T12:00:00');
    const diffMs = curr.getTime() - prev.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays > maxGapDays) {
      gaps.push({
        fromDate: candles[i - 1].date,
        toDate: candles[i].date,
        calendarDays: diffDays,
      });
    }
  }
  return gaps;
}
