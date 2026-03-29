/**
 * Market Breadth Analysis
 *
 * Measures the health of the overall market by analyzing the percentage
 * of stocks above their key moving averages. Healthy markets have broad
 * participation; unhealthy markets have narrow leadership.
 *
 * Used as a macro-level filter:
 * - Strong breadth (>60% above MA20): confident entries
 * - Weak breadth (<30% above MA20): reduce exposure, tighter stops
 * - Divergence (index up but breadth declining): distribution warning
 *
 * This is computed from the scan batch itself (no external data needed).
 */

import { StockScanResult } from '@/lib/scanner/types';

export interface MarketBreadthResult {
  /** % of scanned stocks in 多頭 (uptrend) */
  uptrendPct: number;
  /** Average six conditions score across all scanned stocks */
  avgConditionScore: number;
  /** Market breadth classification */
  breadth: 'STRONG' | 'MODERATE' | 'WEAK' | 'VERY_WEAK';
  /** Composite score adjustment based on breadth */
  compositeAdjust: number;
}

/**
 * Compute market breadth from scan results.
 * Call this after scanning to get macro-level context.
 */
export function computeMarketBreadth(
  results: StockScanResult[],
  totalScanned: number,
): MarketBreadthResult {
  if (totalScanned === 0) {
    return { uptrendPct: 0, avgConditionScore: 0, breadth: 'VERY_WEAK', compositeAdjust: -10 };
  }

  // Pass rate: what % of all scanned stocks passed our filters
  const passRate = results.length / totalScanned * 100;

  // Of those that passed, what's the average score
  const avgConditionScore = results.length > 0
    ? results.reduce((sum, r) => sum + r.sixConditionsScore, 0) / results.length
    : 0;

  // Uptrend percentage (from passed stocks - proxy for broad participation)
  const uptrendCount = results.filter(r => r.trendState === '多頭').length;
  const uptrendPct = results.length > 0 ? (uptrendCount / results.length) * 100 : 0;

  let breadth: MarketBreadthResult['breadth'];
  let compositeAdjust: number;

  // Classification based on pass rate and uptrend participation
  if (passRate > 5 && uptrendPct > 70) {
    breadth = 'STRONG';
    compositeAdjust = 5;     // broad market strength → slight bonus
  } else if (passRate > 2 && uptrendPct > 50) {
    breadth = 'MODERATE';
    compositeAdjust = 0;
  } else if (passRate > 0.5) {
    breadth = 'WEAK';
    compositeAdjust = -5;    // narrow market → reduce confidence
  } else {
    breadth = 'VERY_WEAK';
    compositeAdjust = -10;   // very few stocks passing → high risk
  }

  return { uptrendPct, avgConditionScore, breadth, compositeAdjust };
}
