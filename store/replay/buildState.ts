/**
 * Build derived state for a given candle index — computes all analysis layers.
 *
 * Extracted from replayStore to separate analysis computation from UI state.
 */

import {
  CandleWithIndicators,
  AccountState,
  AccountMetrics,
  RuleSignal,
  PerformanceStats,
  ChartSignalMarker,
} from '@/types';
import { computeMetrics } from '@/lib/engines/tradeEngine';
import { computeStats } from '@/lib/engines/statsEngine';
import {
  detectTrend,
  detectTrendPosition,
  evaluateSixConditions,
  TrendState,
  TrendPosition,
  SixConditionsResult,
} from '@/lib/analysis/trendAnalysis';
import { checkLongProhibitions, checkShortProhibitions, type ProhibitionResult } from '@/lib/rules/entryProhibitions';
import { evaluateShortSixConditions, type ShortSixConditionsResult } from '@/lib/analysis/shortAnalysis';
import { evaluateWinnerPatterns, type WinnerPatternResult } from '@/lib/rules/winnerPatternRules';
import { useSettingsStore } from '@/store/settingsStore';
import { ensureEngineUpToDate, getActiveEngine, getCachedMarkers } from './signalCache';

export interface DerivedState {
  visibleCandles: CandleWithIndicators[];
  metrics: AccountMetrics;
  stats: PerformanceStats;
  currentSignals: RuleSignal[];
  chartMarkers: ChartSignalMarker[];
  trendState: TrendState;
  trendPosition: TrendPosition;
  sixConditions: SixConditionsResult | null;
  longProhibitions: ProhibitionResult | null;
  shortProhibitions: ProhibitionResult | null;
  shortConditions: ShortSixConditionsResult | null;
  winnerPatterns: WinnerPatternResult | null;
}

/**
 * Compute all derived state for the given candle index.
 * This is called on every candle navigation, trade, and strategy change.
 */
export function buildState(
  allCandles: CandleWithIndicators[],
  index: number,
  account: AccountState,
): DerivedState {
  ensureEngineUpToDate(allCandles);

  const currentPrice = allCandles[index]?.close ?? 0;
  const metrics = computeMetrics(account, currentPrice);
  const stats = computeStats(account, allCandles, index);
  const signals = getActiveEngine().evaluate(allCandles, index);
  const visibleCandles = allCandles.slice(0, index + 1);

  // Binary search for visible markers (markers are sorted by date asc)
  const cachedMarkers = getCachedMarkers();
  const currentDate = allCandles[index]?.date ?? '';
  let markerEnd = cachedMarkers.length;
  if (cachedMarkers.length > 0 && currentDate) {
    let lo = 0, hi = cachedMarkers.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cachedMarkers[mid].date <= currentDate) lo = mid + 1;
      else hi = mid;
    }
    markerEnd = lo;
  }
  const chartMarkers = cachedMarkers.slice(0, markerEnd);

  const trendState    = detectTrend(allCandles, index);
  const trendPosition = detectTrendPosition(allCandles, index);
  const activeThresholds = useSettingsStore.getState().getActiveStrategy().thresholds;
  const sixConditions = evaluateSixConditions(allCandles, index, activeThresholds);
  const longProhibitions  = index >= 5 ? checkLongProhibitions(allCandles, index)  : null;
  const shortProhibitions = index >= 5 ? checkShortProhibitions(allCandles, index) : null;
  const shortConditions   = index >= 5 ? evaluateShortSixConditions(allCandles, index) : null;
  const winnerPatterns    = index >= 5 ? evaluateWinnerPatterns(allCandles, index)    : null;

  return {
    visibleCandles,
    metrics,
    stats,
    currentSignals: signals,
    chartMarkers,
    trendState,
    trendPosition,
    sixConditions,
    longProhibitions,
    shortProhibitions,
    shortConditions,
    winnerPatterns,
  };
}
