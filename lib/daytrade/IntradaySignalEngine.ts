/**
 * 當沖訊號引擎
 * 根據即時 K 線評估多條規則，回傳觸發的訊號
 */

import type {
  IntradayTradingRule,
  IntradaySignal,
  IntradayCandleWithIndicators,
  IntradayTimeframe,
  IntradayRuleContext,
  MultiTimeframeState,
} from './types';
import { defaultIntradayRules } from './intradayRules';

export class IntradaySignalEngine {
  private rules: IntradayTradingRule[];

  constructor(rules?: IntradayTradingRule[]) {
    this.rules = rules ?? [...defaultIntradayRules];
  }

  addRule(rule: IntradayTradingRule): void {
    this.rules.push(rule);
  }

  removeRule(ruleId: string): void {
    this.rules = this.rules.filter(r => r.id !== ruleId);
  }

  getRules(): IntradayTradingRule[] {
    return [...this.rules];
  }

  /**
   * 評估當前 K 棒的所有適用規則
   */
  evaluate(
    candles: IntradayCandleWithIndicators[],
    currentIndex: number,
    timeframe: IntradayTimeframe,
    mtfState?: MultiTimeframeState,
  ): IntradaySignal[] {
    if (currentIndex < 0 || currentIndex >= candles.length) return [];

    // 計算開盤區間（前 30 根 1m 或等效）
    const openRangeMinutes = 30;
    const minuteMap: Record<string, number> = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '60m': 60 };
    const tfMinutes = minuteMap[timeframe] ?? 5;
    const openRangeBars = Math.ceil(openRangeMinutes / tfMinutes);
    let openRangeHigh: number | undefined;
    let openRangeLow: number | undefined;

    if (candles.length >= openRangeBars) {
      const orSlice = candles.slice(0, openRangeBars);
      openRangeHigh = Math.max(...orSlice.map(c => c.high));
      openRangeLow  = Math.min(...orSlice.map(c => c.low));
    }

    const context: IntradayRuleContext = {
      timeframe,
      mtfState,
      openRangeHigh,
      openRangeLow,
    };

    const signals: IntradaySignal[] = [];

    for (const rule of this.rules) {
      // 跳過不適用此週期的規則
      if (!rule.applicableTimeframes.includes(timeframe)) continue;

      try {
        const signal = rule.evaluate(candles, currentIndex, context);
        if (signal) {
          // 多週期共振加分（按共振強度縮放，不再固定+15）
          if (mtfState && signal.type === 'BUY') {
            if (mtfState.overallBias === 'bullish') {
              const bonus = Math.min(10, Math.round(mtfState.confluenceScore / 10));
              signal.score = Math.min(100, signal.score + bonus);
              signal.metadata.confluenceFactors = [
                ...(signal.metadata.confluenceFactors ?? []),
                `多週期共振偏多(+${bonus})`,
              ];
            } else if (mtfState.overallBias === 'bearish' && mtfState.confluenceScore >= 70) {
              // 強烈偏空時買入訊號降分（弱偏空不懲罰，給日內反轉機會）
              signal.score = Math.max(0, signal.score - 10);
              signal.reason += ' ⚠多週期偏空';
            }
          }
          if (mtfState && signal.type === 'SELL' && mtfState.overallBias === 'bearish') {
            const bonus = Math.min(10, Math.round(mtfState.confluenceScore / 10));
            signal.score = Math.min(100, signal.score + bonus);
          }

          // R:R ratio 過濾：買入訊號必須有 >= 1.5 的風險報酬比
          if (signal.type === 'BUY' && signal.metadata.targetPrice && signal.metadata.stopLossPrice) {
            const reward = signal.metadata.targetPrice - signal.price;
            const risk = signal.price - signal.metadata.stopLossPrice;
            if (risk > 0) {
              const rr = reward / risk;
              signal.metadata.riskRewardRatio = Math.round(rr * 100) / 100;
              if (rr < 1.2) {
                signal.score = Math.max(0, signal.score - 10);  // 低 R:R 降低信心分
                signal.reason += ` (R:R=${rr.toFixed(1)} 偏低)`;
              }
            }
          }

          signals.push(signal);
        }
      } catch {
        // 單條規則失敗不影響其他
      }
    }

    // 按分數排序
    return signals.sort((a, b) => b.score - a.score);
  }

  /**
   * 批量評估：對整組 K 線逐根計算訊號
   */
  evaluateAll(
    candles: IntradayCandleWithIndicators[],
    timeframe: IntradayTimeframe,
    mtfState?: MultiTimeframeState,
  ): IntradaySignal[] {
    const all: IntradaySignal[] = [];
    for (let i = 0; i < candles.length; i++) {
      const sigs = this.evaluate(candles, i, timeframe, mtfState);
      all.push(...sigs);
    }
    return all;
  }
}
