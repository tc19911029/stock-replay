import { CandleWithIndicators } from '@/types';
import { ruleEngine } from '@/lib/rules/ruleEngine';
import { evaluateSixConditions, detectTrend, detectTrendPosition, TrendState } from '@/lib/analysis/trendAnalysis';
import { checkLongProhibitions, checkShortProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateShortSixConditions } from '@/lib/analysis/shortAnalysis';
import { StockScanResult, MarketConfig, TriggeredRule, ScanDiagnostics, createEmptyDiagnostics } from './types';
import type { StrategyThresholds } from '@/lib/strategy/StrategyConfig';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import { evaluateHighWinRateEntry } from '@/lib/analysis/highWinRateEntry';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { evaluateMultiTimeframe, MultiTimeframeResult } from '@/lib/analysis/multiTimeframeFilter';
import { getScannerCache, setScannerCache, getScannerCacheStats } from '@/lib/datasource/ScannerCache';
import { loadLocalCandlesWithTolerance, saveLocalCandles } from '@/lib/datasource/LocalCandleStore';

const CONCURRENCY = 8; // parallel requests per chunk (降低避免打爆外部 API)
const BATCH_DELAY_MS = 300; // 每批次間隔 ms

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export type StockEntry = { symbol: string; name: string; industry?: string };

export abstract class MarketScanner {
  abstract getMarketConfig(): MarketConfig;
  abstract getStockList(): Promise<StockEntry[]>;
  abstract fetchCandles(symbol: string, asOfDate?: string): Promise<CandleWithIndicators[]>;
  abstract getMarketTrend(asOfDate?: string): Promise<TrendState>;

  /**
   * 掃描專用 fetchCandles — 三層快取：記憶體 → 本地檔案 → API
   * 走圖（單股即時）不經過這裡，直接用 fetchCandles()
   */
  protected async fetchCandlesForScan(
    symbol: string,
    asOfDate?: string,
    diag?: ScanDiagnostics,
  ): Promise<CandleWithIndicators[]> {
    const today = new Date().toISOString().split('T')[0];
    const isHistorical = !!asOfDate && asOfDate < today;
    const market = this.getMarketConfig().marketId as 'TW' | 'CN';

    if (isHistorical) {
      // L1: 記憶體快取
      const memCached = getScannerCache(symbol, asOfDate);
      if (memCached) {
        if (diag) diag.memoryCacheHits++;
        return memCached;
      }

      // L2: 本地檔案（容忍 5 個交易日差距）
      try {
        const local = await loadLocalCandlesWithTolerance(symbol, market, asOfDate, 5);
        if (local && local.candles.length > 0) {
          setScannerCache(symbol, asOfDate, local.candles);
          if (diag) {
            diag.localCacheHits++;
            if (local.staleDays > 0) diag.localCacheStale++;
          }
          return local.candles;
        }
      } catch { /* 本地讀取失敗，fallback 到 API */ }
    } else {
      // 今日掃描：也先嘗試本地檔案（容忍 3 個交易日，即週末/假日差距）
      // 本地數據通常是昨天或前幾天的，差距很小，對均線策略影響可忽略
      try {
        const local = await loadLocalCandlesWithTolerance(symbol, market, today, 3);
        if (local && local.candles.length > 0) {
          if (diag) {
            diag.localCacheHits++;
            if (local.staleDays > 0) diag.localCacheStale++;
          }
          // 今日不寫入 L1 記憶體快取，每次掃描取最新本地數據
          return local.candles;
        }
      } catch { /* 本地讀取失敗，fallback 到 API */ }
    }

    // L3: 不再在掃描時打外部 API — 記錄缺失，回傳空陣列
    // API 呼叫只在 cron 盤後下載或掃描前 ingest 補缺時發生
    if (diag) {
      diag.dataMissing++;
      if (diag.missingSymbols.length < 20) {
        diag.missingSymbols.push(symbol);
      }
    }
    return [];
  }

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
    _minScore: number,
    thresholds: StrategyThresholds,
    asOfDate?: string,
    industry?: string,
    diag?: ScanDiagnostics,
  ): Promise<StockScanResult | null> {
    try {
      let name = rawName;
      if (/\.(SZ|SS)$/i.test(symbol)) {
        try {
          const code = symbol.replace(/\.(SZ|SS)$/i, '');
          const { getCNChineseName } = await import('@/lib/datasource/TWSENames');
          const cnName = await getCNChineseName(code);
          if (cnName) name = cnName;
        } catch { /* 查不到就用東方財富的名字 */ }
      }

      const candles = await this.fetchCandlesForScan(symbol, asOfDate, diag);
      if (candles.length < 30) {
        if (diag) diag.tooFewCandles++;
        return null;
      }

      const lastIdx = candles.length - 1;
      const last = candles[lastIdx];

      // ══════════════════════════════════════════════════════════════════
      // 第零層：長線保護短線（多時間框架前置過濾）
      // ══════════════════════════════════════════════════════════════════

      let mtfResult: MultiTimeframeResult | undefined;
      if (thresholds.multiTimeframeFilter) {
        mtfResult = evaluateMultiTimeframe(candles, thresholds);
        if (!mtfResult.pass) { if (diag) diag.filteredOut++; return null; }
      }

      // ══════════════════════════════════════════════════════════════════
      // 第一層：選股（純朱家泓書本體系）
      // ══════════════════════════════════════════════════════════════════

      // ── 1. 六大條件（前5個=核心門檻，第6個 KD/MACD=候補加分）──────────
      const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
      if (!sixConds.isCoreReady) { if (diag) diag.filteredOut++; return null; }

      // ── 2. 短線第9條：KD值向下時不買 ─────────────────────────────────
      if (last.kdK != null && lastIdx > 0) {
        const prevKdK = candles[lastIdx - 1]?.kdK;
        if (prevKdK != null && last.kdK < prevKdK) { if (diag) diag.filteredOut++; return null; }
      }

      // ── 3. 短線第10條：進場紅K線上影線超過二分之一 → 不買進 ───────────
      const dayRange = last.high - last.low;
      const entryUpperShadow = last.high - last.close;
      if (dayRange > 0 && entryUpperShadow / dayRange > 0.5) { if (diag) diag.filteredOut++; return null; }

      // ── 4. 10大戒律：硬性禁忌過濾（朱老師 p.54）─────────────────────
      const prohib = checkLongProhibitions(candles, lastIdx);
      if (prohib.prohibited) { if (diag) diag.filteredOut++; return null; }

      // ── 5. 淘汰法 R1-R11（寶典）─────────────────────────────────────
      const elimination = evaluateElimination(candles, lastIdx);
      if (elimination.eliminated) { if (diag) diag.filteredOut++; return null; }

      // ══════════════════════════════════════════════════════════════════
      // 第二層：排序資料收集（共振 + 高勝率進場）
      // ══════════════════════════════════════════════════════════════════

      const trend = detectTrend(candles, lastIdx);
      const position = detectTrendPosition(candles, lastIdx);
      const signals = ruleEngine.evaluate(candles, lastIdx);

      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId: s.ruleId, ruleName: s.label, signalType: s.type, reason: s.description,
      }));

      // ── 共振因子：BUY/ADD 訊號數量 + 跨群組共振 ─────────────────────
      const buySignals = signals.filter(s => s.type === 'BUY' || s.type === 'ADD');
      const uniqueGroups = new Set(buySignals.map(s => ('groupId' in s ? (s as { groupId: string }).groupId : s.ruleId.split('.')[0])));
      const resonanceScore = buySignals.length + uniqueGroups.size;

      // ── 高勝率進場位置（朱老師《活用技術分析寶典》Part 12）─────────────
      let highWinRateEntry: ReturnType<typeof evaluateHighWinRateEntry> = {
        matched: false, types: [], score: 0, details: [],
      };
      try {
        highWinRateEntry = evaluateHighWinRateEntry(candles, lastIdx);
      } catch { /* non-critical */ }

      const changePercent = lastIdx > 0 && candles[lastIdx - 1]?.close > 0
        ? +((last.close - candles[lastIdx - 1].close) / candles[lastIdx - 1].close * 100).toFixed(2)
        : 0;

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
        // ── 排序因子 ─────────────────────────────────────────────────────
        resonanceScore,
        highWinRateTypes: highWinRateEntry.types,
        highWinRateScore: highWinRateEntry.score,
        highWinRateDetails: highWinRateEntry.details,
        // ── 淘汰法（資訊保留，供 UI 顯示）──────────────────────────────
        eliminationReasons: elimination.reasons,
        eliminationPenalty: elimination.penalty,
        // ── 長線保護短線（多時間框架）──────────────────────────────────
        ...(mtfResult ? {
          mtfScore: mtfResult.totalScore,
          mtfWeeklyTrend: mtfResult.weekly.trend,
          mtfWeeklyPass: mtfResult.weekly.pass,
          mtfWeeklyDetail: mtfResult.weekly.detail,
          mtfMonthlyTrend: mtfResult.monthly.trend,
          mtfMonthlyPass: mtfResult.monthly.pass,
          mtfMonthlyDetail: mtfResult.monthly.detail,
          mtfWeeklyNearResistance: mtfResult.weeklyNearResistance,
        } : {}),
      };
    } catch (err) {
      if (diag && diag.errorSamples.length < 5) {
        diag.errorSamples.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return null;
    }
  }

  /**
   * @deprecated 已合併到 scanOne()，保留為向下相容別名
   */
  private scanOnePure(
    symbol: string,
    rawName: string,
    config: MarketConfig,
    minScore: number,
    thresholds: StrategyThresholds,
    asOfDate?: string,
    industry?: string,
  ): Promise<StockScanResult | null> {
    return this.scanOne(symbol, rawName, config, minScore, thresholds, asOfDate, industry);
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

    for (let ci = 0; ci < chunks.length; ci++) {
      const promises = chunks[ci].map(s =>
        this.scanOnePure(s.symbol, s.name, config, minScore, th, asOfDate, s.industry)
      );
      const settled = await Promise.allSettled(promises);
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
      if (ci < chunks.length - 1) await sleep(BATCH_DELAY_MS);
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
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState; diagnostics: ScanDiagnostics }> {
    return this._scanChunk(stocks, undefined, thresholds);
  }

  /** Scan a provided sub-list of stocks as of a specific historical date (backtest mode) */
  async scanListAtDate(
    stocks: StockEntry[],
    asOfDate: string,
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState; diagnostics: ScanDiagnostics }> {
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
      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);
    }

    results.sort((a, b) => b.sixConditionsScore - a.sixConditionsScore);
    return { results, marketTrend };
  }

  /**
   * 做空版單股掃描：純朱家泓書本體系（空頭六條件 + 做空戒律）
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

      const candles = await this.fetchCandlesForScan(symbol, asOfDate);
      if (candles.length < 30) return null;

      const lastIdx = candles.length - 1;
      const last = candles[lastIdx];

      // ══════════════════════════════════════════════════════════════════
      // 第一層：選股（純朱家泓書本體系 — 做空版）
      // ══════════════════════════════════════════════════════════════════

      // ── 1. 空頭六條件（前5個=核心門檻）─────────────────────────────
      const shortConds = evaluateShortSixConditions(candles, lastIdx);
      if (!shortConds.isCoreReady) return null;

      // ── 2. 做空戒律 ────────────────────────────────────────────────
      const prohib = checkShortProhibitions(candles, lastIdx);
      if (prohib.prohibited) return null;

      // 書裡沒有做空淘汰法則，不加

      // ══════════════════════════════════════════════════════════════════
      // 第二層：排序資料收集（共振 + 高勝率進場）
      // ══════════════════════════════════════════════════════════════════

      const signals = ruleEngine.evaluate(candles, lastIdx);
      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId: s.ruleId, ruleName: s.label, signalType: s.type, reason: s.description,
      }));

      // ── 共振因子：SELL/REDUCE 訊號數量 + 跨群組共振（方向反轉）────
      const sellSignals = signals.filter(s => s.type === 'SELL' || s.type === 'REDUCE');
      const uniqueGroups = new Set(sellSignals.map(s => ('groupId' in s ? (s as { groupId: string }).groupId : s.ruleId.split('.')[0])));
      const resonanceScore = sellSignals.length + uniqueGroups.size;

      const changePercent = lastIdx > 0 && candles[lastIdx - 1]?.close > 0
        ? +((last.close - candles[lastIdx - 1].close) / candles[lastIdx - 1].close * 100).toFixed(2)
        : 0;

      return {
        symbol,
        name,
        market: config.marketId,
        industry,
        price: last.close,
        changePercent,
        volume: last.volume,
        triggeredRules,
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
        resonanceScore,
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
      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);
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
      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);
    }

    return { candidates, marketTrend };
  }

  /**
   * 候選股排序層 — 台股回測結論：共振100% 表現最佳
   * 排序公式：resonanceScore（共振訊號數+跨群組共振）
   * 回測數據：1947支×244天，共振100% 10日均報+3.23% 勝率45.7%（6組最高）
   */
  rankCandidates(
    candidates: StockScanResult[],
    _rankBy?: string,
  ): StockScanResult[] {
    return [...candidates].sort((a, b) => {
      const scoreA = (a.resonanceScore ?? 0);
      const scoreB = (b.resonanceScore ?? 0);
      return scoreB - scoreA || b.changePercent - a.changePercent;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // V2 簡化版掃描：純朱老師 SOP（六條件+戒律+淘汰法）
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * @deprecated 已合併到 scanOne()，保留為向下相容別名
   */
  private scanOneSOPOnly(
    symbol: string,
    rawName: string,
    config: MarketConfig,
    thresholds: StrategyThresholds,
    asOfDate?: string,
    industry?: string,
  ): Promise<StockScanResult | null> {
    return this.scanOne(symbol, rawName, config, 0, thresholds, asOfDate, industry);
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
      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);
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
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState; diagnostics: ScanDiagnostics }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? ZHU_V1.thresholds;
    const results: StockScanResult[] = [];
    const DEADLINE = Date.now() + 110_000;
    const diag = createEmptyDiagnostics();
    diag.totalStocks = stocks.length;

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
        batch.map(({ symbol, name, industry }) => this.scanOne(symbol, name, config, minScore, th, asOfDate, industry, diag))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
      diag.processedCount += batch.length;
      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);
    }

    let maxResults = results.length;
    if (marketTrend === '盤整') maxResults = Math.min(results.length, 8);
    if (marketTrend === '空頭') maxResults = Math.min(results.length, 3);

    const sortedResults = results
      .sort((a, b) => (b.resonanceScore ?? 0) + (b.highWinRateScore ?? 0) - (a.resonanceScore ?? 0) - (a.highWinRateScore ?? 0) || b.changePercent - a.changePercent)
      .slice(0, maxResults);

    console.info('[ScannerCache]', getScannerCacheStats());
    console.info('[ScanDiagnostics]', JSON.stringify(diag));
    return { results: sortedResults, marketTrend, diagnostics: diag };
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
          (b.resonanceScore ?? 0) + (b.highWinRateScore ?? 0) - (a.resonanceScore ?? 0) - (a.highWinRateScore ?? 0) || b.changePercent - a.changePercent
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
      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);
    }

    const sorted = results.sort((a, b) =>
      (b.resonanceScore ?? 0) + (b.highWinRateScore ?? 0) - (a.resonanceScore ?? 0) - (a.highWinRateScore ?? 0) || b.changePercent - a.changePercent
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
