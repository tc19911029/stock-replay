import { CandleWithIndicators } from '@/types';
import { ruleEngine } from '@/lib/rules/ruleEngine';
import { evaluateSixConditions, detectTrend, detectTrendPosition } from '@/lib/analysis/trendAnalysis';
import { StockScanResult, MarketConfig, TriggeredRule } from './types';

const CONCURRENCY = 8; // parallel requests

export abstract class MarketScanner {
  abstract getMarketConfig(): MarketConfig;
  abstract getStockList(): Promise<Array<{ symbol: string; name: string }>>;
  abstract fetchCandles(symbol: string): Promise<CandleWithIndicators[]>;

  private async scanOne(
    symbol: string,
    name: string,
    config: MarketConfig,
  ): Promise<StockScanResult | null> {
    try {
      const candles = await this.fetchCandles(symbol);
      if (candles.length < 30) return null;

      const lastIdx  = candles.length - 1;
      const last     = candles[lastIdx];
      const prev     = candles[lastIdx - 1];
      const signals  = ruleEngine.evaluate(candles, lastIdx);
      const sixConds = evaluateSixConditions(candles, lastIdx);
      const trend    = detectTrend(candles, lastIdx);
      const position = detectTrendPosition(candles, lastIdx);

      const buySignals = signals.filter(s => s.type === 'BUY' || s.type === 'ADD');
      if (buySignals.length === 0) return null;
      if (trend !== '多頭') return null;

      const changePercent = prev?.close > 0
        ? +((last.close - prev.close) / prev.close * 100).toFixed(2)
        : 0;

      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId:     s.ruleId,
        ruleName:   s.label,
        signalType: s.type,
        reason:     s.description,
      }));

      return {
        symbol,
        name,
        market: config.marketId,
        price: last.close,
        changePercent,
        volume: last.volume,
        triggeredRules,
        sixConditionsScore: sixConds.totalScore,
        sixConditionsBreakdown: {
          trend:     sixConds.trend.pass,
          position:  sixConds.position.pass,
          kbar:      sixConds.kbar.pass,
          ma:        sixConds.ma.pass,
          volume:    sixConds.volume.pass,
          indicator: sixConds.indicator.pass,
        },
        trendState: trend,
        trendPosition: position,
        scanTime: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  async scan(): Promise<StockScanResult[]> {
    const config = this.getMarketConfig();
    const stocks = await this.getStockList();
    const results: StockScanResult[] = [];

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name }) => this.scanOne(symbol, name, config))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }

    return results.sort((a, b) =>
      b.sixConditionsScore !== a.sixConditionsScore
        ? b.sixConditionsScore - a.sixConditionsScore
        : b.changePercent - a.changePercent
    );
  }
}
