import {
  TradingRule,
  RuleSignal,
  RuleContext,
  CandleWithIndicators,
  EnrichedSignal,
  SignalConflict,
  EvaluationResult,
} from '@/types';
import { DEFAULT_REGISTRY, RuleRegistry, RuleGroupId } from './ruleRegistry';

/**
 * Rule Engine — evaluates registered rules at the current replay index.
 *
 * Design:
 * - Rules are pluggable: any object implementing TradingRule can be added
 * - Rules are evaluated independently (no rule depends on another)
 * - Multiple signals can fire on the same candle
 * - Supports group filtering via RuleRegistry
 *
 * Usage:
 * - new RuleEngine()                          → all rules (backward compatible)
 * - new RuleEngine(registry, ['zhu-5steps'])  → only specified groups
 */
export class RuleEngine {
  private rules: TradingRule[];
  private ruleToGroup: Map<string, { groupId: RuleGroupId; groupName: string }>;

  constructor(
    registry: RuleRegistry = DEFAULT_REGISTRY,
    activeGroups?: RuleGroupId[],
  ) {
    this.rules = registry.getRules(activeGroups);
    this.ruleToGroup = registry.buildRuleToGroupMap();
  }

  addRule(rule: TradingRule): void {
    this.rules.push(rule);
  }

  removeRule(ruleId: string): void {
    this.rules = this.rules.filter((r) => r.id !== ruleId);
  }

  getRules(): TradingRule[] {
    return [...this.rules];
  }

  /**
   * Evaluate all rules at the given index.
   * Returns array of triggered signals (backward compatible).
   */
  evaluate(
    candles: CandleWithIndicators[],
    index: number,
    ctx?: RuleContext,
  ): RuleSignal[] {
    if (index < 0 || index >= candles.length) return [];

    const signals: RuleSignal[] = [];
    for (const rule of this.rules) {
      try {
        const signal = rule.evaluate(candles, index, ctx);
        if (signal) signals.push(signal);
      } catch (err) {
        console.warn(
          `[RuleEngine] Rule "${rule.id}" failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return signals;
  }

  /**
   * Evaluate all rules with enriched metadata and conflict detection.
   *
   * Returns:
   * - signals: same as evaluate()
   * - allSignals: each signal tagged with groupId/groupName
   * - conflicts: when BUY/ADD and SELL/REDUCE fire on the same candle
   */
  evaluateDetailed(
    candles: CandleWithIndicators[],
    index: number,
    ctx?: RuleContext,
  ): EvaluationResult {
    const rawSignals = this.evaluate(candles, index, ctx);

    // Enrich with group metadata
    const allSignals: EnrichedSignal[] = rawSignals.map((s) => {
      const group = this.ruleToGroup.get(s.ruleId);
      return {
        ...s,
        groupId: group?.groupId ?? 'unknown',
        groupName: group?.groupName ?? '未知群組',
      };
    });

    // Detect conflicts: BUY/ADD vs SELL/REDUCE on the same candle
    const buySignals = allSignals.filter(
      (s) => s.type === 'BUY' || s.type === 'ADD',
    );
    const sellSignals = allSignals.filter(
      (s) => s.type === 'SELL' || s.type === 'REDUCE',
    );

    const conflicts: SignalConflict[] = [];
    if (buySignals.length > 0 && sellSignals.length > 0) {
      // Find the winning signal by priority
      const PRIORITY: Record<string, number> = {
        SELL: 4, BUY: 3, REDUCE: 2, ADD: 1, WATCH: 0,
      };
      const all = [...buySignals, ...sellSignals];
      const resolution = all.reduce((a, b) =>
        (PRIORITY[b.type] ?? 0) > (PRIORITY[a.type] ?? 0) ? b : a,
      );
      conflicts.push({ buySignals, sellSignals, resolution });
    }

    return { signals: rawSignals, allSignals, conflicts };
  }
}

// Singleton instance — shared across the app (all rules, backward compatible)
export const ruleEngine = new RuleEngine();
