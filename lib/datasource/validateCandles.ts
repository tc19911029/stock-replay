/**
 * OHLCV data quality validation.
 *
 * Detects anomalous candle data before it enters the analysis pipeline.
 * Invalid candles can cause false signals, broken charts, and wrong backtest results.
 */

import type { CandleWithIndicators } from '@/types';

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
 */
export function validateCandles(
  raw: CandleWithIndicators[],
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
    if (c.open > c.high || c.open < c.low || c.close > c.high || c.close < c.low) {
      issues.push(`[${c.date}] OHLC 不一致: O=${c.open} H=${c.high} L=${c.low} C=${c.close}`);
      removed++;
      return false;
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
