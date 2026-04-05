import { CandleWithIndicators } from '@/types';
import { ruleEngine } from '@/lib/rules/ruleEngine';
import { evaluateSixConditions, detectTrend, detectTrendPosition, TrendState } from '@/lib/analysis/trendAnalysis';
import { checkLongProhibitions, checkShortProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateShortSixConditions } from '@/lib/analysis/shortAnalysis';
import { StockScanResult, MarketConfig, TriggeredRule } from './types';
import type { StrategyThresholds } from '@/lib/strategy/StrategyConfig';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import { evaluateHighWinRateEntry } from '@/lib/analysis/highWinRateEntry';
import { evaluateWinnerPatterns } from '@/lib/rules/winnerPatternRules';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { analyzeTrendlines } from '@/lib/analysis/trendlineAnalysis';

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

      // 2. 六大條件門檻（書上規定：前5個是必要條件，第6個「指標」是輔助）
      if (!sixConds.isCoreReady) return null;

      // 3. 乖離過大
      if (last.ma20 && last.ma20 > 0) {
        const overExtended = (last.close - last.ma20) / last.ma20 > thresholds.deviationMax;
        if (overExtended) return null;
      }
      // 4. KD 超買
      if (last.kdK != null && last.kdK > thresholds.kdMaxEntry) return null;

      // 5. 複合過熱檢查 — 多個過熱指標同時觸發 = 頂部信號，直接拒絕
      {
        let overheatCount = 0;
        if (last.rsi14 != null && last.rsi14 > 75) overheatCount++;
        const bar5Ago = lastIdx >= 5 ? candles[lastIdx - 5] : undefined;
        if (bar5Ago && bar5Ago.close > 0) {
          const roc5 = ((last.close - bar5Ago.close) / bar5Ago.close) * 100;
          if (roc5 > 8) overheatCount++;
        }
        if (last.roc10 != null && last.roc10 > 15) overheatCount++;
        if (last.ma20 && last.ma20 > 0 && (last.close - last.ma20) / last.ma20 > 0.12) overheatCount++;
        if (last.kdK != null && last.kdK > 85) overheatCount++;
        if (overheatCount >= 3) return null;
      }

      // 6. 成交量太低 — 過濾冷門股
      const minVolume = config.marketId === 'CN' ? 50000 : 1000;
      if (last.volume < minVolume) return null;

      // 7. 漲停隔天不追
      if (prev && prev.close > 0) {
        const prevChange = (last.close - prev.close) / prev.close;
        let limitUp = 0.095;
        if (config.marketId === 'CN') {
          const code = symbol.replace(/\.(SS|SZ)$/i, '');
          if (code.startsWith('688') || code.startsWith('300')) {
            limitUp = 0.195;
          }
        }
        if (prevChange >= limitUp) return null;
      }

      // 8. 末升段不進場
      if (position.includes('末升')) return null;

      // 9. A-share mean reversion filter
      if (config.marketId === 'CN') {
        const rsi = last.rsi14;
        const roc10 = last.roc10;
        if (rsi != null && rsi > 80 && roc10 != null && roc10 > 15) return null;
      }

      // 10. 紅K必要條件 — 朱老師核心：黑K不進場
      if (last.close <= last.open) return null;

      // 10.5 短線第9條：KD值向下時不買
      if (last.kdK != null && lastIdx > 0) {
        const prevKdK = candles[lastIdx - 1]?.kdK;
        if (prevKdK != null && last.kdK < prevKdK) {
          return null;
        }
      }

      // 10.6 短線第10條：進場紅K線上影線超過二分之一 → 不買進
      const dayRange = last.high - last.low;
      const entryUpperShadow = last.high - last.close;
      if (dayRange > 0 && entryUpperShadow / dayRange > 0.5) return null;

      // 11. 突破前5日高點
      const recentHighs = candles.slice(Math.max(0, lastIdx - 5), lastIdx).map(c => c.high);
      const prev5High = Math.max(...recentHighs);
      if (prev5High > 0 && last.close < prev5High) return null;

      // 12. 新鮮訊號必要條件 — 當日必須觸發至少一個 BUY/ADD 訊號
      const hasBuySignal = signals.some(s => s.type === 'BUY' || s.type === 'ADD');
      if (!hasBuySignal) return null;

      const changePercent = prev?.close > 0
        ? +((last.close - prev.close) / prev.close * 100).toFixed(2)
        : 0;

      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId:     s.ruleId,
        ruleName:   s.label,
        signalType: s.type,
        reason:     s.description,
      }));

      // ── 歷史信號勝率 ─────────────────────────────────────────────────────
      let histWinRate: number | undefined;
      let histSignalCount = 0;
      let histWinCount = 0;
      const histEnd = lastIdx - 6;
      const histStart = Math.max(60, lastIdx - 120);

      for (let h = histStart; h < histEnd; h++) {
        const hSix = evaluateSixConditions(candles, h, thresholds);
        if (hSix.totalScore < minScore) continue;
        const entryIdx = h + 1;
        if (entryIdx >= candles.length) continue;
        const entryPrice = candles[entryIdx].open;
        if (!entryPrice || entryPrice <= 0) continue;
        const exitIdx = Math.min(entryIdx + 5, candles.length - 1);
        const exitPrice = candles[exitIdx].close;
        histSignalCount++;
        if (exitPrice > entryPrice) histWinCount++;
      }

      if (histSignalCount >= 8) {
        histWinRate = Math.round((histWinCount / histSignalCount) * 100);
      }

      // ── 10大戒律：硬性禁忌過濾（朱老師p.54）────────────────────────────
      {
        const prohib = checkLongProhibitions(candles, lastIdx);
        if (prohib.prohibited) return null;
      }

      // ── 高勝率進場位置 (朱老師《活用技術分析寶典》Part 12) ──────────────
      let highWinRateEntry: ReturnType<typeof evaluateHighWinRateEntry> = {
        matched: false, types: [], score: 0, details: [],
      };
      try {
        highWinRateEntry = evaluateHighWinRateEntry(candles, lastIdx);
      } catch { /* non-critical */ }

      // ── 33 種贏家圖像 (朱老師 40 年精華) ──────────────────────────────
      let winnerPatterns: ReturnType<typeof evaluateWinnerPatterns> = {
        bearishPatterns: [], bullishPatterns: [], compositeAdjust: 0,
      };
      try {
        winnerPatterns = evaluateWinnerPatterns(candles, lastIdx);
      } catch { /* non-critical */ }

      // ── 切線分析 ──────────────────────────────────────────────────────
      let trendline: ReturnType<typeof analyzeTrendlines> = {
        trendlines: [], breakAboveDescending: false, breakBelowAscending: false,
        ascendingSupport: null, descendingResistance: null, compositeAdjust: 0,
      };
      try {
        trendline = analyzeTrendlines(candles, lastIdx);
      } catch { /* non-critical */ }

      // ── 淘汰法篩選 ────────────────────────────────────────────────────
      let elimination: ReturnType<typeof evaluateElimination> = {
        eliminated: false, reasons: [], penalty: 0,
      };
      try {
        elimination = evaluateElimination(candles, lastIdx);
      } catch { /* non-critical */ }

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
        // ── 高勝率進場位置 ────────────────────────────────────────────────
        highWinRateTypes: highWinRateEntry.types,
        highWinRateScore: highWinRateEntry.score,
        highWinRateDetails: highWinRateEntry.details,
        // ── 贏家圖像 ─────────────────────────────────────────────────────
        winnerBearishPatterns: winnerPatterns.bearishPatterns.map(p => p.name),
        winnerBullishPatterns: winnerPatterns.bullishPatterns.map(p => p.name),
        // ── 切線 ─────────────────────────────────────────────────────────
        trendlineBreakAbove: trendline.breakAboveDescending,
        trendlineBreakBelow: trendline.breakBelowAscending,
        // ── 淘汰法 ──────────────────────────────────────────────────────
        eliminationReasons: elimination.reasons,
        eliminationPenalty: elimination.penalty,
      };
    } catch {
      return null;
    }
  }

  /**
   * 純朱家泓選股：只保留六大條件 SOP 核心篩選，不加任何額外分析層
   * 用於 A/B 測試，對比完整管線 vs 純方法論的勝率差異
   */
  private async scanOnePure(
    symbol: string,
    rawName: string,
    config: MarketConfig,
    minScore: number,
    thresholds: StrategyThresholds,
    asOfDate?: string,
    industry?: string,
  ): Promise<StockScanResult | null> {
    try {
      let name = rawName;
      if (/\.(SZ|SS)$/i.test(symbol)) {
        try {
          const code = symbol.replace(/\.(SZ|SS)$/i, '');
          const { getCNChineseName } = await import('@/lib/datasource/TWSENames');
          const cnName = await getCNChineseName(code);
          if (cnName) name = cnName;
        } catch { /* fallback */ }
      }

      const candles = await this.fetchCandles(symbol, asOfDate);
      if (candles.length < 30) return null;

      const lastIdx = candles.length - 1;
      const last    = candles[lastIdx];
      const signals = ruleEngine.evaluate(candles, lastIdx);
      const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
      const trend    = detectTrend(candles, lastIdx);
      const position = detectTrendPosition(candles, lastIdx);

      // ── 純朱老師核心篩選（只有 8 條） ──
      if (trend === '空頭') return null;
      if (!sixConds.isCoreReady && sixConds.totalScore < minScore) return null;
      if (last.close <= last.open) return null; // 非紅K
      if (last.ma20 && last.ma20 > 0) {
        if ((last.close - last.ma20) / last.ma20 > thresholds.deviationMax) return null;
      }
      if (last.kdK != null && last.kdK > thresholds.kdMaxEntry) return null;
      const recentHighs = candles.slice(Math.max(0, lastIdx - 5), lastIdx).map(c => c.high);
      const prev5High = Math.max(...recentHighs);
      if (prev5High > 0 && last.close < prev5High) return null;
      const hasBuySignal = signals.some(s => s.type === 'BUY' || s.type === 'ADD');
      if (!hasBuySignal) return null;

      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId: s.ruleId, ruleName: s.label, reason: s.reason, signalType: s.type,
      }));

      const changePercent = last.open > 0
        ? +((last.close - last.open) / last.open * 100).toFixed(2)
        : 0;

      return {
        symbol, name,
        market: config.marketId,
        industry,
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
        scanTime: asOfDate ? `${asOfDate}T00:00:00.000Z` : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * 純朱家泓掃描：用 scanOnePure，按六大條件排序
   */
  async scanPure(
    thresholds?: StrategyThresholds,
    asOfDate?: string,
  ): Promise<{ results: StockScanResult[]; marketTrend?: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const marketTrend = await this.getMarketTrend(asOfDate);
    const minScore = this.marketTrendToMinScore(marketTrend, th);

    const stockList = await this.getStockList();
    const results: StockScanResult[] = [];

    const chunks: StockEntry[][] = [];
    for (let i = 0; i < stockList.length; i += CONCURRENCY) {
      chunks.push(stockList.slice(i, i + CONCURRENCY));
    }

    for (const chunk of chunks) {
      const promises = chunk.map(s =>
        this.scanOnePure(s.symbol, s.name, config, minScore, th, asOfDate, s.industry)
      );
      const settled = await Promise.allSettled(promises);
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }

    results.sort((a, b) => b.sixConditionsScore - a.sixConditionsScore);
    return { results, marketTrend };
  }

  /**
   * Compute full scan data for a single ticker WITHOUT any entry filters.
   * Used by the AI analysis engine to get accurate technical context.
   */
  async fetchStockScanData(symbol: string, name: string): Promise<StockScanResult | null> {
    try {
      const candles = await this.fetchCandles(symbol);
      if (candles.length < 30) return null;

      const lastIdx = candles.length - 1;
      const last    = candles[lastIdx];
      const prev    = candles[lastIdx - 1];

      const config = this.getMarketConfig();
      const thresholds = ZHU_V1.thresholds;
      const signals  = ruleEngine.evaluate(candles, lastIdx);
      const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
      const trend    = detectTrend(candles, lastIdx);
      const position = detectTrendPosition(candles, lastIdx);

      const changePercent = prev?.close > 0
        ? +((last.close - prev.close) / prev.close * 100).toFixed(2) : 0;

      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId: s.ruleId, ruleName: s.label, signalType: s.type, reason: s.description,
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

  /**
   * 純朱家泓掃描（歷史日期版）：只用六大條件核心篩選
   */
  async scanListAtDatePure(
    stocks: StockEntry[],
    asOfDate: string,
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const results: StockScanResult[] = [];

    let minScore = th.minScore;
    let marketTrend: TrendState = '多頭';
    try {
      marketTrend = await this.getMarketTrend(asOfDate);
      if (th.marketTrendFilter) {
        minScore = this.marketTrendToMinScore(marketTrend, th);
      }
    } catch { /* fallback */ }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) =>
          this.scanOnePure(symbol, name, config, minScore, th, asOfDate, industry)
        )
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }

    results.sort((a, b) => b.sixConditionsScore - a.sixConditionsScore);
    return { results, marketTrend };
  }

  /**
   * 做空版單股掃描（Phase 3 新增）
   */
  private async scanOneShort(
    symbol: string,
    rawName: string,
    config: MarketConfig,
    thresholds: StrategyThresholds,
    asOfDate?: string,
    industry?: string,
  ): Promise<StockScanResult | null> {
    try {
      let name = rawName;
      if (/\.(SZ|SS)$/i.test(symbol)) {
        try {
          const code = symbol.replace(/\.(SZ|SS)$/i, '');
          const { getCNChineseName } = await import('@/lib/datasource/TWSENames');
          const cnName = await getCNChineseName(code);
          if (cnName) name = cnName;
        } catch { /* fallback */ }
      }

      const candles = await this.fetchCandles(symbol, asOfDate);
      if (candles.length < 30) return null;

      const lastIdx  = candles.length - 1;
      const last     = candles[lastIdx];
      const prev     = candles[lastIdx - 1];

      const shortConds = evaluateShortSixConditions(candles, lastIdx);
      if (!shortConds.isCoreReady) return null;

      const prohib = checkShortProhibitions(candles, lastIdx);
      if (prohib.prohibited) return null;

      if (last.close >= last.open) return null;

      const minVolume = config.marketId === 'CN' ? 50000 : 1000;
      if (last.volume < minVolume) return null;

      if (prev && prev.close > 0) {
        const prevChange = (last.close - prev.close) / prev.close;
        let limitUp = 0.095;
        if (config.marketId === 'CN') {
          const code = symbol.replace(/\.(SS|SZ)$/i, '');
          if (code.startsWith('688') || code.startsWith('300')) limitUp = 0.195;
        }
        if (prevChange >= limitUp) return null;
      }

      const changePercent = prev?.close > 0
        ? +((last.close - prev.close) / prev.close * 100).toFixed(2)
        : 0;

      return {
        symbol,
        name,
        market: config.marketId,
        industry,
        price: last.close,
        changePercent,
        volume: last.volume,
        triggeredRules: [],
        sixConditionsScore: 0,
        sixConditionsBreakdown: {
          trend: false, position: false, kbar: false, ma: false, volume: false, indicator: false,
        },
        shortSixConditionsScore: shortConds.totalScore,
        shortSixConditionsBreakdown: {
          trend:     shortConds.trend.pass,
          ma:        shortConds.ma.pass,
          position:  shortConds.position.pass,
          volume:    shortConds.volume.pass,
          kbar:      shortConds.kbar.pass,
          indicator: shortConds.indicator.pass,
        },
        direction: 'short',
        entryProhibitionReasons: [],
        trendState: '空頭',
        trendPosition: shortConds.position.stage ?? '',
        scanTime: asOfDate ? `${asOfDate}T00:00:00.000Z` : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * 做空候選股篩選層
   */
  async scanShortCandidates(
    stocks: StockEntry[],
    asOfDate?: string,
    thresholds?: StrategyThresholds,
  ): Promise<{ candidates: StockScanResult[]; marketTrend: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const candidates: StockScanResult[] = [];

    let marketTrend: TrendState = '空頭';
    try {
      marketTrend = await this.getMarketTrend(asOfDate);
    } catch { /* fallback */ }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) =>
          this.scanOneShort(symbol, name, config, th, asOfDate, industry)
        )
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) candidates.push(r.value);
      }
    }

    candidates.sort((a, b) => (b.shortSixConditionsScore ?? 0) - (a.shortSixConditionsScore ?? 0));
    return { candidates, marketTrend };
  }

  /**
   * 候選股篩選層
   */
  async scanCandidates(
    stocks: StockEntry[],
    asOfDate?: string,
    thresholds?: StrategyThresholds,
  ): Promise<{ candidates: StockScanResult[]; marketTrend: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const candidates: StockScanResult[] = [];

    let marketTrend: TrendState = '多頭';
    try {
      marketTrend = await this.getMarketTrend(asOfDate);
    } catch { /* fallback */ }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) =>
          this.scanOnePure(symbol, name, config, th.minScore, th, asOfDate, industry)
        )
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) {
          candidates.push(r.value);
        }
      }
    }

    return { candidates, marketTrend };
  }

  /**
   * 候選股排序層 — 按六大條件分數排序
   */
  rankCandidates(
    candidates: StockScanResult[],
    rankBy: 'sixConditions' | 'histWinRate' = 'sixConditions',
  ): StockScanResult[] {
    return [...candidates].sort((a, b) => {
      switch (rankBy) {
        case 'histWinRate':
          return (b.histWinRate ?? 0) - (a.histWinRate ?? 0);
        case 'sixConditions':
        default:
          return b.sixConditionsScore - a.sixConditionsScore
            || b.changePercent - a.changePercent;
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // V2 簡化版掃描：純朱老師 SOP（六條件+戒律+淘汰法）
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * V2 簡化版單股篩選：嚴格只用朱老師 SOP
   */
  private async scanOneSOPOnly(
    symbol: string,
    rawName: string,
    config: MarketConfig,
    thresholds: StrategyThresholds,
    asOfDate?: string,
    industry?: string,
  ): Promise<StockScanResult | null> {
    try {
      let name = rawName;
      if (/\.(SZ|SS)$/i.test(symbol)) {
        try {
          const code = symbol.replace(/\.(SZ|SS)$/i, '');
          const { getCNChineseName } = await import('@/lib/datasource/TWSENames');
          const cnName = await getCNChineseName(code);
          if (cnName) name = cnName;
        } catch { /* fallback */ }
      }

      const candles = await this.fetchCandles(symbol, asOfDate);
      if (candles.length < 30) return null;

      const lastIdx = candles.length - 1;
      const last = candles[lastIdx];

      const trend = detectTrend(candles, lastIdx);
      if (trend === '空頭') return null;

      const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
      if (!sixConds.isCoreReady) return null;

      const prohibitions = checkLongProhibitions(candles, lastIdx);
      if (prohibitions.prohibited) return null;

      const elimination = evaluateElimination(candles, lastIdx);
      if (elimination.eliminated) return null;

      const position = detectTrendPosition(candles, lastIdx);
      const signals = ruleEngine.evaluate(candles, lastIdx);
      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId: s.ruleId, ruleName: s.label, reason: s.reason, signalType: s.type,
      }));
      const changePercent = last.open > 0
        ? +((last.close - last.open) / last.open * 100).toFixed(2)
        : 0;

      return {
        symbol, name,
        market: config.marketId,
        industry,
        price: last.close,
        changePercent,
        volume: last.volume,
        triggeredRules,
        sixConditionsScore: sixConds.totalScore,
        sixConditionsBreakdown: {
          trend: sixConds.trend.pass,
          position: sixConds.position.pass,
          kbar: sixConds.kbar.pass,
          ma: sixConds.ma.pass,
          volume: sixConds.volume.pass,
          indicator: sixConds.indicator.pass,
        },
        trendState: trend,
        trendPosition: position,
        scanTime: asOfDate ? `${asOfDate}T00:00:00.000Z` : new Date().toISOString(),
        eliminationReasons: elimination.reasons,
        eliminationPenalty: elimination.penalty,
      };
    } catch {
      return null;
    }
  }

  /**
   * V2 簡化版掃描入口
   */
  async scanSOP(
    stocks: StockEntry[],
    asOfDate?: string,
    thresholds?: StrategyThresholds,
    rankBy: 'sixConditions' | 'histWinRate' = 'sixConditions',
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const candidates: StockScanResult[] = [];

    let marketTrend: TrendState = '多頭';
    try {
      marketTrend = await this.getMarketTrend(asOfDate);
    } catch { /* fallback */ }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) =>
          this.scanOneSOPOnly(symbol, name, config, th, asOfDate, industry)
        )
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) candidates.push(r.value);
      }
    }

    const sorted = this.rankCandidates(candidates, rankBy);

    const maxResults = marketTrend === '空頭' ? 3 : marketTrend === '盤整' ? 8 : sorted.length;

    return {
      results: sorted.slice(0, maxResults),
      marketTrend,
    };
  }

  private async _scanChunk(
    stocks: StockEntry[],
    asOfDate: string | undefined,
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const results: StockScanResult[] = [];
    const DEADLINE = Date.now() + 110_000;

    let minScore = th.minScore;
    let marketTrend: TrendState = '多頭';
    try {
      marketTrend = await this.getMarketTrend(asOfDate);
      if (th.marketTrendFilter) {
        minScore = this.marketTrendToMinScore(marketTrend, th);
      }
    } catch { /* fallback */ }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      if (Date.now() > DEADLINE) break;
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) => this.scanOne(symbol, name, config, minScore, th, asOfDate, industry))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }

    let maxResults = results.length;
    if (marketTrend === '盤整') maxResults = Math.min(results.length, 8);
    if (marketTrend === '空頭') maxResults = Math.min(results.length, 3);

    const sortedResults = results
      .sort((a, b) => b.sixConditionsScore - a.sixConditionsScore || b.changePercent - a.changePercent)
      .slice(0, maxResults);

    return { results: sortedResults, marketTrend };
  }

  async scan(thresholds?: StrategyThresholds): Promise<{ results: StockScanResult[]; partial: boolean; marketTrend?: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const stocks = await this.getStockList();
    const results: StockScanResult[] = [];
    const DEADLINE = Date.now() + 240_000;

    let minScore = th.minScore;
    let marketTrend: TrendState = '多頭';
    try {
      marketTrend = await this.getMarketTrend();
      if (th.marketTrendFilter) {
        minScore = this.marketTrendToMinScore(marketTrend, th);
      }
    } catch { /* fallback */ }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      if (Date.now() > DEADLINE) {
        const sorted = results.sort((a, b) =>
          b.sixConditionsScore - a.sixConditionsScore || b.changePercent - a.changePercent
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

    const sorted = results.sort((a, b) =>
      b.sixConditionsScore - a.sixConditionsScore || b.changePercent - a.changePercent
    );

    let maxResults = sorted.length;
    if (marketTrend === '盤整') maxResults = Math.min(sorted.length, 8);
    if (marketTrend === '空頭') maxResults = Math.min(sorted.length, 3);

    return {
      results: sorted.slice(0, maxResults),
      partial: false,
      marketTrend,
    };
  }
}
