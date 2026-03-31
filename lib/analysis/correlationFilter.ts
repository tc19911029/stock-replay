/**
 * Correlation-Based Position Filter
 *
 * Prevents hidden concentration risk by filtering out stocks whose
 * recent returns are highly correlated. When two candidates have
 * correlation > threshold, only the one with the higher composite
 * score is kept.
 *
 * Research basis:
 * - Institutional best practice caps single-factor exposure
 * - Seemingly diversified positions (different stocks, even different sectors)
 *   can move together due to shared factor exposure
 * - Correlation-adjusted "effective positions" is more meaningful than raw count
 */

import type { CandleWithIndicators } from '@/types';

export interface CorrelationFilterResult {
  /** Stocks that passed the filter */
  kept: string[];
  /** Stocks removed due to high correlation */
  removed: Array<{ symbol: string; correlatedWith: string; correlation: number }>;
}

/**
 * Compute pairwise Pearson correlation of daily returns over the lookback window.
 */
function pearsonCorrelation(returnsA: number[], returnsB: number[]): number {
  const n = Math.min(returnsA.length, returnsB.length);
  if (n < 5) return 0;

  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += returnsA[i];
    sumB += returnsB[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const dA = returnsA[i] - meanA;
    const dB = returnsB[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }

  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : 0;
}

/**
 * Compute daily returns from candle close prices.
 * Returns array of daily return percentages.
 */
function computeDailyReturns(candles: CandleWithIndicators[], lookback: number): number[] {
  const returns: number[] = [];
  const start = Math.max(1, candles.length - lookback);
  for (let i = start; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (prev > 0) {
      returns.push((candles[i].close - prev) / prev);
    }
  }
  return returns;
}

/**
 * Filter scan results by pairwise return correlation.
 *
 * Process:
 * 1. Results must already be sorted by compositeScore (highest first)
 * 2. For each candidate, check correlation with already-kept stocks
 * 3. If correlation > threshold with any kept stock, remove the candidate
 *
 * @param symbols        Candidate symbols sorted by compositeScore (best first)
 * @param candlesMap     Map of symbol → candle data
 * @param threshold      Correlation threshold (default 0.7)
 * @param lookbackDays   Days of returns to compute correlation over (default 20)
 */
export function filterByCorrelation(
  symbols: string[],
  candlesMap: Record<string, CandleWithIndicators[]>,
  threshold = 0.7,
  lookbackDays = 20,
): CorrelationFilterResult {
  const kept: string[] = [];
  const removed: CorrelationFilterResult['removed'] = [];

  // Pre-compute returns for all candidates
  const returnsMap = new Map<string, number[]>();
  for (const sym of symbols) {
    const candles = candlesMap[sym];
    if (candles && candles.length > lookbackDays) {
      returnsMap.set(sym, computeDailyReturns(candles, lookbackDays));
    }
  }

  for (const sym of symbols) {
    const returns = returnsMap.get(sym);
    if (!returns || returns.length < 5) {
      // No return data — keep by default
      kept.push(sym);
      continue;
    }

    let tooCorrelated = false;
    let correlatedWith = '';
    let maxCorr = 0;

    for (const keptSym of kept) {
      const keptReturns = returnsMap.get(keptSym);
      if (!keptReturns) continue;

      const corr = pearsonCorrelation(returns, keptReturns);
      if (corr > threshold && corr > maxCorr) {
        tooCorrelated = true;
        correlatedWith = keptSym;
        maxCorr = corr;
      }
    }

    if (tooCorrelated) {
      removed.push({
        symbol: sym,
        correlatedWith,
        correlation: +maxCorr.toFixed(3),
      });
    } else {
      kept.push(sym);
    }
  }

  return { kept, removed };
}
