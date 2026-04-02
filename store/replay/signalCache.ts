/**
 * Signal marker cache — precomputes buy/sell markers across all candles.
 *
 * Extracted from replayStore to separate signal computation from UI state.
 * Module-level state is intentional: shared across store rebuilds for performance.
 */

import { CandleWithIndicators, ChartSignalMarker } from '@/types';
import { RuleEngine, ruleEngine } from '@/lib/rules/ruleEngine';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { useSettingsStore } from '@/store/settingsStore';

// Module-level cache
let _cachedMarkers: ChartSignalMarker[] = [];
let _activeEngine: RuleEngine = ruleEngine;
let _signalStrengthMin = 2;
let _lastStrategyId = '';

export function getActiveEngine(): RuleEngine {
  return _activeEngine;
}

export function getCachedMarkers(): readonly ChartSignalMarker[] {
  return _cachedMarkers;
}

export function getSignalStrengthMin(): number {
  return _signalStrengthMin;
}

export function setSignalStrengthMin(min: number): void {
  _signalStrengthMin = min;
}

/**
 * Build a filtered RuleEngine based on the current strategy's rule groups.
 */
function buildFilteredEngine(): RuleEngine {
  const strategy = useSettingsStore.getState().getActiveStrategy();
  _lastStrategyId = strategy.id;
  if (strategy.ruleGroups && strategy.ruleGroups.length > 0) {
    return new RuleEngine(undefined, strategy.ruleGroups);
  }
  return ruleEngine;
}

/**
 * Check if strategy has changed and recompute markers if needed.
 */
export function ensureEngineUpToDate(allCandles: CandleWithIndicators[]): void {
  const currentId = useSettingsStore.getState().getActiveStrategy().id;
  if (currentId !== _lastStrategyId && allCandles.length > 0) {
    precomputeMarkers(allCandles);
  }
}

/**
 * Precompute all signal markers for the given candle series.
 * Called on stock load and strategy change.
 */
export function precomputeMarkers(allCandles: CandleWithIndicators[]): void {
  _activeEngine = buildFilteredEngine();
  const strategy = useSettingsStore.getState().getActiveStrategy();
  const minScore = strategy.thresholds.minScore ?? 4;
  const result: ChartSignalMarker[] = [];

  for (let i = 0; i < allCandles.length; i++) {
    const c = allCandles[i];

    const isBullish = c.ma5 != null && c.ma20 != null && c.ma5 > c.ma20;
    const isBearish = c.ma5 != null && c.ma20 != null && c.ma5 < c.ma20;

    const { allSignals } = _activeEngine.evaluateDetailed(allCandles, i);

    const buyGroups = new Set(
      allSignals
        .filter(s => (s.type === 'BUY' || s.type === 'ADD') && isBullish)
        .map(s => s.groupId),
    );
    const sellGroups = new Set(
      allSignals
        .filter(s => (s.type === 'SELL' || s.type === 'REDUCE') && isBearish)
        .map(s => s.groupId),
    );

    const buyStrength = buyGroups.size;
    const sellStrength = sellGroups.size;

    if (buyStrength >= _signalStrengthMin) {
      const score = minScore > 1 ? evaluateSixConditions(allCandles, i, strategy.thresholds).totalScore : 6;
      if (score >= minScore) {
        result.push({
          date: c.date,
          type: 'BUY',
          label: `買 ×${buyStrength} (${score}/6)`,
          strength: buyStrength,
        });
      }
    }
    if (sellStrength >= _signalStrengthMin) {
      result.push({
        date: c.date,
        type: 'SELL',
        label: sellStrength >= 3 ? `強賣 ×${sellStrength}` : `賣 ×${sellStrength}`,
        strength: sellStrength,
      });
    }
  }

  _cachedMarkers = result;
}

/**
 * Clear cached markers (e.g., during stock load transition).
 */
export function clearCachedMarkers(): void {
  _cachedMarkers = [];
}
