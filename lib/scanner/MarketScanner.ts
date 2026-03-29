import { CandleWithIndicators } from '@/types';
import { ruleEngine } from '@/lib/rules/ruleEngine';
import { evaluateSixConditions, detectTrend, detectTrendPosition, TrendState } from '@/lib/analysis/trendAnalysis';
import { StockScanResult, MarketConfig, TriggeredRule } from './types';
import type { StrategyThresholds } from '@/lib/strategy/StrategyConfig';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import { computeSurgeScore } from '@/lib/analysis/surgeScore';
import { computeSmartMoneyScore, computeCompositeScore, detectConsecutiveBullish } from '@/lib/analysis/smartMoneyScore';
import { computeRetailSentiment } from '@/lib/analysis/retailSentiment';
import { analyzeSupportResistance } from '@/lib/analysis/supportResistance';
import { detectVolatilityRegime } from '@/lib/analysis/volatilityRegime';
import { computeMarketBreadth } from '@/lib/analysis/marketBreadth';
import { computeSeasonality } from '@/lib/analysis/seasonality';
import { analyzeCrossTimeframe } from '@/lib/analysis/crossTimeframe';
import { computeRelativeStrength } from '@/lib/analysis/relativeStrength';
import { analyzeGaps } from '@/lib/analysis/gapAnalysis';
import { detectCandlePatterns } from '@/lib/analysis/candlePatterns';

const CONCURRENCY = 15; // parallel requests per chunk

export type StockEntry = { symbol: string; name: string; industry?: string };

export abstract class MarketScanner {
  abstract getMarketConfig(): MarketConfig;
  abstract getStockList(): Promise<StockEntry[]>;
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
    rawName: string,
    config: MarketConfig,
    minScore: number,
    thresholds: StrategyThresholds,
    asOfDate?: string,
    industry?: string,
  ): Promise<StockScanResult | null> {
    try {
      // 陸股：用動態 API 取最新公司名（東方財富 f14 可能是舊名）
      let name = rawName;
      if (/\.(SZ|SS)$/i.test(symbol)) {
        try {
          const code = symbol.replace(/\.(SZ|SS)$/i, '');
          const { getCNChineseName } = await import('@/lib/datasource/TWSENames');
          const cnName = await getCNChineseName(code);
          if (cnName) name = cnName;
        } catch { /* 查不到就用東方財富的名字 */ }
      }

      const candles = await this.fetchCandles(symbol, asOfDate);
      if (candles.length < 30) return null;

      const lastIdx  = candles.length - 1;
      const last     = candles[lastIdx];
      const prev     = candles[lastIdx - 1];
      const signals  = ruleEngine.evaluate(candles, lastIdx);
      const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
      const trend    = detectTrend(candles, lastIdx);
      const position = detectTrendPosition(candles, lastIdx);

      // ── 篩股條件（嚴格版 — 寧可錯過，不可做錯）────────────────────────────
      // 1. 空頭趨勢：嚴禁做多
      if (trend === '空頭') return null;

      // 先計算 surgeScore
      const surge = computeSurgeScore(candles, lastIdx);

      // 2. 六大條件門檻 — 不再降門檻，嚴格執行
      if (sixConds.totalScore < minScore) return null;

      // 3. 最低飆股潛力分 — 過濾弱勢股
      const minSurge = config.marketId === 'CN' ? 30 : 40;  // 陸股門檻稍低（波動結構不同）
      if (surge.totalScore < minSurge) return null;

      // 4. 乖離過大 — surgeScore ≥ 65 的飆股可豁免（真飆股本來就會乖離大）
      if (surge.totalScore < 65 && last.ma20 && last.ma20 > 0) {
        const overExtended = (last.close - last.ma20) / last.ma20 > thresholds.deviationMax;
        if (overExtended) return null;
      }
      // 5. KD 超買 — surgeScore ≥ 65 的飆股可豁免
      if (surge.totalScore < 65 && last.kdK != null && last.kdK > thresholds.kdMaxEntry) return null;

      // 6. 成交量太低 — 過濾冷門股（陸股量能單位不同，門檻不同）
      const minVolume = config.marketId === 'CN' ? 50000 : 1000;  // A股用手，台股用張
      if (last.volume < minVolume) return null;

      // 7. 漲停隔天不追 — 前一天漲幅過大的不進場
      if (prev && prev.close > 0) {
        const prevChange = (last.close - prev.close) / prev.close;
        const limitUp = config.marketId === 'CN' ? 0.095 : 0.095;  // A股和台股都用 9.5%
        if (prevChange >= limitUp) return null;
      }

      // 8. 末升段不進場 — 位置太高風險大
      if (position.includes('末升')) return null;

      // 9. A-share mean reversion filter: extremely overbought RSI + high
      //    short-term gains signal incoming mean reversion (A-shares are
      //    retail-dominated → overreaction → reversal)
      if (config.marketId === 'CN' && surge.totalScore < 75) {
        const rsi = last.rsi14;
        const roc10 = last.roc10;
        // RSI > 80 AND 10-day gain > 15% = very likely to mean-revert
        if (rsi != null && rsi > 80 && roc10 != null && roc10 > 15) return null;
      }

      // 10-11 改為加分項（不再硬過濾，避免掃不出來）
      // 這些因素會透過 surgeScore 和六大條件間接反映

      const changePercent = prev?.close > 0
        ? +((last.close - prev.close) / prev.close * 100).toFixed(2)
        : 0;

      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId:     s.ruleId,
        ruleName:   s.label,
        signalType: s.type,
        reason:     s.description,
      }));

      // ── 歷史信號勝率（模擬真實交易：隔日開盤買→持有5天收盤賣）──────────
      let histWinRate: number | undefined;
      let histSignalCount = 0;
      let histWinCount = 0;
      // 回測最近 90 天的信號（需預留 6 天 forward data）
      const histEnd = lastIdx - 6;
      const histStart = Math.max(60, lastIdx - 90);
      for (let h = histStart; h < histEnd; h++) {
        const hSix = evaluateSixConditions(candles, h, thresholds);
        if (hSix.totalScore < minScore) continue;  // 用實際門檻
        // 隔日開盤買入
        const entryIdx = h + 1;
        if (entryIdx >= candles.length) continue;
        const entryPrice = candles[entryIdx].open;
        if (!entryPrice || entryPrice <= 0) continue;
        // 5 天後收盤賣出
        const exitIdx = Math.min(entryIdx + 5, candles.length - 1);
        const exitPrice = candles[exitIdx].close;
        histSignalCount++;
        if (exitPrice > entryPrice) histWinCount++;
      }
      if (histSignalCount >= 3) {
        histWinRate = Math.round((histWinCount / histSignalCount) * 100);
      }

      // 12. 歷史勝率過低 — 這支股票歷史上同類信號表現差，跳過
      if (histWinRate !== undefined && histWinRate < 35) return null;

      // ── Smart Money Score & Composite Ranking ────────────────────────────
      const smartMoney = computeSmartMoneyScore(candles, lastIdx);
      const { bonus: consecutiveBonus } = detectConsecutiveBullish(candles, lastIdx);
      const composite = computeCompositeScore(
        sixConds.totalScore,
        surge.totalScore,
        smartMoney.totalScore,
        histWinRate,
        config.marketId,
        consecutiveBonus,
      );

      // ── Retail Sentiment Contrarian Filter ──────────────────────────────
      const sentiment = computeRetailSentiment(candles, lastIdx);
      if (sentiment.compositeAdjust !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + sentiment.compositeAdjust
        ));
      }

      // ── Support/Resistance Proximity ────────────────────────────────────
      const sr = analyzeSupportResistance(candles, lastIdx);
      if (sr.proximityScore !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + sr.proximityScore
        ));
      }

      // ── Calendar Seasonality ────────────────────────────────────────────
      const scanDate = asOfDate ?? new Date().toISOString().split('T')[0];
      const seasonality = computeSeasonality(scanDate, config.marketId);
      if (seasonality.adjustment !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + seasonality.adjustment
        ));
      }

      // ── Cross-Timeframe Confirmation (weekly trend) ─────────────────────
      const weekly = analyzeCrossTimeframe(candles, lastIdx);
      if (weekly.compositeAdjust !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + weekly.compositeAdjust
        ));
      }

      // ── Relative Strength ───────────────────────────────────────────────
      const rs = computeRelativeStrength(candles, lastIdx);
      if (rs.compositeAdjust !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + rs.compositeAdjust
        ));
      }

      // ── Gap Analysis ───────────────────────────────────────────────────
      const gapResult = analyzeGaps(candles, lastIdx);
      if (gapResult.compositeAdjust !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + gapResult.compositeAdjust
        ));
      }

      // ── Candlestick Patterns ────────────────────────────────────────────
      const candlePattern = detectCandlePatterns(candles, lastIdx);
      if (candlePattern.compositeAdjust !== 0) {
        composite.compositeScore = Math.max(0, Math.min(100,
          composite.compositeScore + candlePattern.compositeAdjust
        ));
      }

      return {
        symbol,
        name,
        market: config.marketId,
        industry,
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
        smartMoneyScore: smartMoney.totalScore,
        smartMoneyGrade: smartMoney.grade,
        compositeScore: composite.compositeScore,
        retailSentiment: sentiment.sentimentScore,
        contrarianSignal: sentiment.contrarianSignal,
        volatilityRegime: detectVolatilityRegime(candles, lastIdx).regime,
      };
    } catch {
      return null;
    }
  }

  /** Scan a provided sub-list of stocks (used by chunked parallel scanning) */
  async scanList(
    stocks: StockEntry[],
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState }> {
    return this._scanChunk(stocks, undefined, thresholds);
  }

  /** Scan a provided sub-list of stocks as of a specific historical date (backtest mode) */
  async scanListAtDate(
    stocks: StockEntry[],
    asOfDate: string,
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState }> {
    return this._scanChunk(stocks, asOfDate, thresholds);
  }

  private async _scanChunk(
    stocks: StockEntry[],
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
        batch.map(({ symbol, name, industry }) => this.scanOne(symbol, name, config, minScore, th, asOfDate, industry))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }
    this.applySectorMomentum(results);
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
        this.applySectorMomentum(results);
        const sorted = results.sort((a, b) =>
          (b.compositeScore ?? 0) !== (a.compositeScore ?? 0)
            ? (b.compositeScore ?? 0) - (a.compositeScore ?? 0)
            : (b.surgeScore ?? 0) !== (a.surgeScore ?? 0)
            ? (b.surgeScore ?? 0) - (a.surgeScore ?? 0)
            : b.sixConditionsScore - a.sixConditionsScore
        );
        return { results: sorted, partial: true, marketTrend };
      }
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) => this.scanOne(symbol, name, config, minScore, th, undefined, industry))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }

    // ── Sector momentum: hot sectors get bonus ──────────────────────────────
    this.applySectorMomentum(results);

    // ── Market breadth: adjust all scores by overall market health ────────
    const breadth = computeMarketBreadth(results, stocks.length);
    if (breadth.compositeAdjust !== 0) {
      for (const r of results) {
        r.compositeScore = Math.max(0, Math.min(100,
          (r.compositeScore ?? 0) + breadth.compositeAdjust
        ));
      }
    }
    console.log(`[${config.marketId}] Market breadth: ${breadth.breadth} (${breadth.uptrendPct.toFixed(0)}% uptrend, adjust: ${breadth.compositeAdjust > 0 ? '+' : ''}${breadth.compositeAdjust})`);

    return {
      results: results.sort((a, b) =>
        (b.compositeScore ?? 0) !== (a.compositeScore ?? 0)
          ? (b.compositeScore ?? 0) - (a.compositeScore ?? 0)
          : (b.surgeScore ?? 0) !== (a.surgeScore ?? 0)
          ? (b.surgeScore ?? 0) - (a.surgeScore ?? 0)
          : b.sixConditionsScore - a.sixConditionsScore
      ),
      partial: false,
      marketTrend,
    };
  }

  /**
   * Sector momentum scoring: when multiple stocks from the same sector/industry
   * pass the scanner filters, it indicates institutional rotation into that sector.
   * Hot sectors get a compositeScore bonus (up to +20).
   *
   * Thresholds:
   * - 2 stocks in same sector: +5 bonus
   * - 3 stocks: +10 bonus
   * - 4 stocks: +15 bonus
   * - 5+ stocks: +20 bonus (max)
   */
  private applySectorMomentum(results: StockScanResult[]): void {
    // Group by industry/sector
    const sectorCounts = new Map<string, number>();
    for (const r of results) {
      const sector = r.industry;
      if (!sector) continue;
      sectorCounts.set(sector, (sectorCounts.get(sector) ?? 0) + 1);
    }

    // Apply bonus to stocks in hot sectors
    for (const r of results) {
      const sector = r.industry;
      if (!sector) continue;
      const count = sectorCounts.get(sector) ?? 0;
      let bonus = 0;
      if (count >= 5) bonus = 20;
      else if (count >= 4) bonus = 15;
      else if (count >= 3) bonus = 10;
      else if (count >= 2) bonus = 5;

      if (bonus > 0) {
        r.sectorHeat = bonus;
        r.compositeScore = Math.min(100, (r.compositeScore ?? 0) + bonus);
      }
    }
  }
}
