import { StrategyThresholds, BUILT_IN_STRATEGIES, ZHU_V1 } from './StrategyConfig';

/**
 * Server-side helper: resolve strategy thresholds from request params.
 *
 * Client can send either:
 * - `strategyId` (string) → resolve from built-in strategies
 * - `thresholds` (object) → use directly (for custom strategies)
 *
 * Falls back to ZHU_V1 defaults if neither is provided.
 */
export function resolveThresholds(params: {
  strategyId?: string;
  thresholds?: Partial<StrategyThresholds>;
}): StrategyThresholds {
  // If full thresholds object is provided, merge with defaults
  if (params.thresholds) {
    return { ...ZHU_V1.thresholds, ...params.thresholds };
  }

  // Resolve from built-in strategy by ID
  if (params.strategyId) {
    const found = BUILT_IN_STRATEGIES.find(s => s.id === params.strategyId);
    if (found) return found.thresholds;
  }

  return ZHU_V1.thresholds;
}
