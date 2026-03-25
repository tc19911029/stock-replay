import { CandleWithIndicators } from '@/types';
import { ruleEngine } from '@/lib/rules/ruleEngine';
import { evaluateSixConditions, detectTrend, detectTrendPosition } from '@/lib/analysis/trendAnalysis';
import { StockScanResult, MarketConfig, TriggeredRule } from './types';

export abstract class MarketScanner {
  abstract getMarketConfig(): MarketConfig;
  abstract getStockList(): Promise<Array<{ symbol: string; name: string }>>;
  abstract fetchCandles(symbol: string): Promise<CandleWithIndicators[]>;

  async scan(): Promise<StockScanResult[]> {
    const config  = this.getMarketConfig();
    const stocks  = await this.getStockList();
    const results: StockScanResult[] = [];

    for (const { symbol, name } of stocks) {
      try {
        const candles = await this.fetchCandles(symbol);
        if (candles.length < 30) continue;

        const lastIdx   = candles.length - 1;
        const last      = candles[lastIdx];
        const prev      = candles[lastIdx - 1];
        const signals   = ruleEngine.evaluate(candles, lastIdx);
        const sixConds  = evaluateSixConditions(candles, lastIdx);
        const trend     = detectTrend(candles, lastIdx);
        const position  = detectTrendPosition(candles, lastIdx);

        // Only include if there's at least one BUY/ADD signal AND trend is 多頭
        const buySignals = signals.filter(s => s.type === 'BUY' || s.type === 'ADD');
        if (buySignals.length === 0) continue;
        if (trend !== '多頭') continue;

        const changePercent = prev?.close > 0
          ? +((last.close - prev.close) / prev.close * 100).toFixed(2)
          : 0;

        const triggeredRules: TriggeredRule[] = signals.map(s => ({
          ruleId:     s.ruleId,
          ruleName:   s.label,
          signalType: s.type,
          reason:     s.description,
        }));

        results.push({
          symbol,
          name,
          market: config.marketId,
          price: last.close,
          changePercent,
          volume: last.volume,
          triggeredRules,
          sixConditionsScore: sixConds.totalScore,
          trendState: trend,
          trendPosition: position,
          scanTime: new Date().toISOString(),
        });
      } catch {
        // Single stock failure should not abort the whole scan
        continue;
      }
    }

    // Sort by six-conditions score desc, then by change % desc
    return results.sort((a, b) =>
      b.sixConditionsScore !== a.sixConditionsScore
        ? b.sixConditionsScore - a.sixConditionsScore
        : b.changePercent - a.changePercent
    );
  }
}
