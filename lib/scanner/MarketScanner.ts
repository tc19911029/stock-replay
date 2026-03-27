import { CandleWithIndicators } from '@/types';
import { ruleEngine } from '@/lib/rules/ruleEngine';
import { evaluateSixConditions, detectTrend, detectTrendPosition, TrendState } from '@/lib/analysis/trendAnalysis';
import { StockScanResult, MarketConfig, TriggeredRule } from './types';
import type { StrategyThresholds } from '@/lib/strategy/StrategyConfig';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import { computeSurgeScore } from '@/lib/analysis/surgeScore';

const CONCURRENCY = 15; // parallel requests per chunk

export abstract class MarketScanner {
  abstract getMarketConfig(): MarketConfig;
  abstract getStockList(): Promise<Array<{ symbol: string; name: string }>>;
  abstract fetchCandles(symbol: string, asOfDate?: string): Promise<CandleWithIndicators[]>;
  abstract getMarketTrend(asOfDate?: string): Promise<TrendState>;

  /**
   * 根據大盤趨勢動態計算個股最低分數門檻
   * 使用策略設定的 bullMinScore / sidewaysMinScore / bearMinScore
   */
  private marketTrendToMinScore(marketTrend: TrendState, thresholds: StrategyThresholds): number {
    if (marketTrend === '多頭') return thresholds.bullMinScore;
    if (marketTrend === '盤整') return thresholds.sidewaysMinScore;
    return thresholds.bearMinScore; // 空頭
  }

  private async scanOne(
    symbol: string,
    name: string,
    config: MarketConfig,
    minScore: number,
    thresholds: StrategyThresholds,
    asOfDate?: string,
  ): Promise<StockScanResult | null> {
    try {
      const candles = await this.fetchCandles(symbol, asOfDate);
      if (candles.length < 30) return null;

      const lastIdx  = candles.length - 1;
      const last     = candles[lastIdx];
      const prev     = candles[lastIdx - 1];
      const signals  = ruleEngine.evaluate(candles, lastIdx);
      const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
      const trend    = detectTrend(candles, lastIdx);
      const position = detectTrendPosition(candles, lastIdx);

      // ── 篩股條件 ─────────────────────────────────────────────────────────
      // 1. 空頭趨勢：嚴禁做多
      if (trend === '空頭') return null;

      // 先計算 surgeScore（用於後續寬鬆篩選）
      const surge = computeSurgeScore(candles, lastIdx);

      // 2. 六大條件門檻 — surgeScore 高分可降低門檻（飆股優先）
      const effectiveMinScore = surge.totalScore >= 60
        ? Math.max(minScore - 1, 3)  // 高潛力飆股門檻降 1 分，最低 3
        : minScore;
      if (sixConds.totalScore < effectiveMinScore) return null;

      // 3. 乖離過大 — 但 surgeScore 高分豁免（飆股本來就會乖離大）
      if (surge.totalScore < 55 && last.ma20 && last.ma20 > 0) {
        const overExtended = (last.close - last.ma20) / last.ma20 > thresholds.deviationMax;
        if (overExtended) return null;
      }
      // 4. KD 超買 — 但 surgeScore 高分豁免
      if (surge.totalScore < 55 && last.kdK != null && last.kdK > thresholds.kdMaxEntry) return null;

      const changePercent = prev?.close > 0
        ? +((last.close - prev.close) / prev.close * 100).toFixed(2)
        : 0;

      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId:     s.ruleId,
        ruleName:   s.label,
        signalType: s.type,
        reason:     s.description,
      }));

      // ── 歷史信號勝率（用已有 K 線快速計算）──────────────────────────────
      let histWinRate: number | undefined;
      let histSignalCount = 0;
      let histWinCount = 0;
      // 只回測最近 120 天內的信號（不含最後 20 天因為需要 forward data）
      const histEnd = lastIdx - 20;
      const histStart = Math.max(30, lastIdx - 120);
      for (let h = histStart; h < histEnd; h++) {
        const hSix = evaluateSixConditions(candles, h, thresholds);
        if (hSix.totalScore < 4) continue;
        histSignalCount++;
        // 20 日回報 > 0 算贏
        if (h + 20 < candles.length && candles[h + 20].close > candles[h].close) histWinCount++;
      }
      if (histSignalCount >= 3) {
        histWinRate = Math.round((histWinCount / histSignalCount) * 100);
      }

      return {
        symbol,
        name,
        market: config.marketId,
        price: last.close,
        changePercent,
        volume: last.volume,
        triggeredRules,
        sixConditionsScore: sixConds.totalScore,
        histWinRate,
        histSignalCount,
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
        scanTime: asOfDate ? `${asOfDate}T00:00:00.000Z` : new Date().toISOString(),
        surgeScore: surge.totalScore,
        surgeGrade: surge.grade,
        surgeFlags: surge.flags,
        surgeComponents: surge.components,
      };
    } catch {
      return null;
    }
  }

  /** Scan a provided sub-list of stocks (used by chunked parallel scanning) */
  async scanList(
    stocks: Array<{ symbol: string; name: string }>,
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState }> {
    return this._scanChunk(stocks, undefined, thresholds);
  }

  /** Scan a provided sub-list of stocks as of a specific historical date (backtest mode) */
  async scanListAtDate(
    stocks: Array<{ symbol: string; name: string }>,
    asOfDate: string,
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState }> {
    return this._scanChunk(stocks, asOfDate, thresholds);
  }

  private async _scanChunk(
    stocks: Array<{ symbol: string; name: string }>,
    asOfDate: string | undefined,
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const results: StockScanResult[] = [];
    const DEADLINE = Date.now() + 110_000; // 110s per chunk

    // ── 大盤趨勢過濾：動態調整最低分數門檻 ──────────────────────────────────
    let minScore = th.minScore;
    let marketTrend: TrendState = '多頭';
    try {
      marketTrend = await this.getMarketTrend(asOfDate);
      if (th.marketTrendFilter) {
        minScore = this.marketTrendToMinScore(marketTrend, th);
      }
      console.log(`[${config.marketId}] 大盤趨勢: ${marketTrend} → 最低門檻: ${minScore}分`);
    } catch (e) {
      console.warn(`[${config.marketId}] 大盤趨勢取得失敗，使用預設門檻${minScore}分`, e);
    }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      if (Date.now() > DEADLINE) {
        console.warn(`[${config.marketId}] Chunk timeout after ${i}/${stocks.length} stocks`);
        break;
      }
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name }) => this.scanOne(symbol, name, config, minScore, th, asOfDate))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }
    return { results, marketTrend };
  }

  async scan(thresholds?: StrategyThresholds): Promise<{ results: StockScanResult[]; partial: boolean; marketTrend?: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const stocks = await this.getStockList();
    const results: StockScanResult[] = [];
    const DEADLINE = Date.now() + 240_000;

    // ── 大盤趨勢過濾 ────────────────────────────────────────────────────────
    let minScore = th.minScore;
    let marketTrend: TrendState = '多頭';
    try {
      marketTrend = await this.getMarketTrend();
      if (th.marketTrendFilter) {
        minScore = this.marketTrendToMinScore(marketTrend, th);
      }
      console.log(`[${config.marketId}] 大盤趨勢: ${marketTrend} → 最低門檻: ${minScore}分`);
    } catch (e) {
      console.warn(`[${config.marketId}] 大盤趨勢取得失敗，使用預設門檻${minScore}分`, e);
    }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      if (Date.now() > DEADLINE) {
        console.warn(`[${config.marketId}] Scan timeout after ${results.length} hits from ${i}/${stocks.length} stocks`);
        const sorted = results.sort((a, b) =>
          (b.surgeScore ?? 0) !== (a.surgeScore ?? 0)
            ? (b.surgeScore ?? 0) - (a.surgeScore ?? 0)
            : b.sixConditionsScore !== a.sixConditionsScore
            ? b.sixConditionsScore - a.sixConditionsScore
            : b.changePercent - a.changePercent
        );
        return { results: sorted, partial: true, marketTrend };
      }
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name }) => this.scanOne(symbol, name, config, minScore, th))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }

    return {
      results: results.sort((a, b) =>
        b.sixConditionsScore !== a.sixConditionsScore
          ? b.sixConditionsScore - a.sixConditionsScore
          : b.changePercent - a.changePercent
      ),
      partial: false,
      marketTrend,
    };
  }
}
