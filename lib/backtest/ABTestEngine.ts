/**
 * ABTestEngine.ts — A/B 測試引擎
 *
 * 比較兩種選股方式的績效差異：
 *   Group A（朱老師 + 選最熱門）：六條件篩選 → 按成交量排序 → 選最大量
 *   Group B（完整系統）：17+ 條規則篩選 → 按 compositeScore 排序 → 選最高分
 *
 * 兩組都用朱老師獲利方程式（runSOPBacktest）出場，確保差異只在選股。
 */

import { MarketId, StockScanResult, ForwardCandle } from '@/lib/scanner/types';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { fetchCandlesRange } from '@/lib/datasource/YahooFinanceDS';
import {
  runSOPBacktest,
  scanResultToSignal,
  PURE_ZHU_STRATEGY,
  BacktestTrade,
  calcBacktestStats,
  BacktestStats,
} from './BacktestEngine';

// ── Types ───────────────────────────────────────────────────────────────────────

export interface StockEntry {
  symbol: string;
  name: string;
}

export interface ABTestConfig {
  market: MarketId;
  fromDate: string;          // YYYY-MM-DD
  toDate: string;            // YYYY-MM-DD
  sampleInterval: number;    // 每 N 個交易日取樣一次（default 5）
  topN: number[];            // 比較哪些排名（default [1, 3, 5]）
  quintiles: boolean;        // 是否做五分位分析（default true）
  stocks?: StockEntry[];     // 可選覆蓋股票清單
}

export type ABTestProgressEvent =
  | { type: 'status';     message: string }
  | { type: 'date_start'; date: string; current: number; total: number }
  | { type: 'date_done';  date: string; groupASignals: number; groupBSignals: number }
  | { type: 'complete';   result: ABTestResult }
  | { type: 'error';      message: string };

export interface TopNSliceResult {
  topN: number;
  groupA: BacktestStats | null;
  groupB: BacktestStats | null;
}

export interface QuintileRow {
  quintile: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  label: string;
  count: number;
  stats: BacktestStats | null;
}

export interface PerDateStats {
  date: string;
  groupATop1Return: number | null;
  groupBTop1Return: number | null;
  groupASignals: number;
  groupBSignals: number;
}

export interface ABTestResult {
  market: MarketId;
  fromDate: string;
  toDate: string;
  datesAnalyzed: number;
  topNResults: TopNSliceResult[];
  quintileRows: QuintileRow[];
  perDateStats: PerDateStats[];
  createdAt: string;
  config: ABTestConfig;
}

// ── Forward candle fetcher (reuses existing pattern) ────────────────────────

const FORWARD_WINDOW_DAYS = 45;

async function fetchForwardCandles(
  symbol: string,
  scanDate: string,
): Promise<ForwardCandle[]> {
  const startMs = Date.parse(scanDate) + 86400_000;
  const endMs = startMs + FORWARD_WINDOW_DAYS * 86400_000;
  const startStr = new Date(startMs).toISOString().split('T')[0];
  const endStr = new Date(endMs).toISOString().split('T')[0];

  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 3600_000);
  const todayStr = utc8.toISOString().split('T')[0];
  const safeEndStr = endStr > todayStr ? todayStr : endStr;

  const candles = await fetchCandlesRange(symbol, startStr, safeEndStr, 8000);
  const filtered = candles.filter(c => c.date > scanDate && c.date <= todayStr);

  return filtered.map((c, i) => {
    let ma5: number | undefined;
    if (i >= 4) {
      const sum5 = filtered.slice(i - 4, i + 1).reduce((s, x) => s + x.close, 0);
      ma5 = +(sum5 / 5).toFixed(2);
    }
    return {
      date: c.date, open: c.open, close: c.close,
      high: c.high, low: c.low, volume: c.volume, ma5,
    };
  });
}

// ── Engine ───────────────────────────────────────────────────────────────────

const CONCURRENCY = 8;

export class ABTestEngine {
  async run(
    config: ABTestConfig,
    onProgress: (event: ABTestProgressEvent) => void,
  ): Promise<ABTestResult> {
    const scanner = config.market === 'CN'
      ? new ChinaScanner()
      : new TaiwanScanner();

    // 1. Get stock list
    onProgress({ type: 'status', message: '取得股票清單...' });
    const stocks = config.stocks ?? (await scanner.getStockList()).slice(0, 100);

    // 2. Get trading dates from index candles
    onProgress({ type: 'status', message: '取得交易日曆...' });
    const tradingDates = await this.getTradingDates(
      config.market, config.fromDate, config.toDate,
    );
    const sampledDates = tradingDates.filter((_, i) => i % config.sampleInterval === 0);

    if (sampledDates.length === 0) {
      throw new Error('日期範圍內沒有交易日');
    }

    onProgress({
      type: 'status',
      message: `共 ${sampledDates.length} 個取樣日期（${sampledDates[0]} ~ ${sampledDates[sampledDates.length - 1]}）`,
    });

    // 3. Accumulate trades per group and per topN
    const maxN = Math.max(...config.topN);
    const groupATrades: Map<number, BacktestTrade[]> = new Map(config.topN.map(n => [n, []]));
    const groupBTrades: Map<number, BacktestTrade[]> = new Map(config.topN.map(n => [n, []]));
    // For quintile analysis: all Group B trades with their compositeScore rank fraction
    const quintileTrades: Array<{ trade: BacktestTrade; rankFraction: number }> = [];
    const perDateStats: PerDateStats[] = [];

    let groupASkipped = 0;
    let groupBSkipped = 0;

    for (let di = 0; di < sampledDates.length; di++) {
      const date = sampledDates[di];
      onProgress({ type: 'date_start', date, current: di + 1, total: sampledDates.length });

      // Run scans — sequential to manage Yahoo rate limits
      let fullResults: StockScanResult[] = [];
      let pureResults: StockScanResult[] = [];

      try {
        const [fullScan, pureScan] = await Promise.all([
          scanner.scanListAtDate(stocks, date).catch(() => ({ results: [] as StockScanResult[], marketTrend: '多頭' as const })),
          scanner.scanListAtDatePure(stocks, date).catch(() => ({ results: [] as StockScanResult[], marketTrend: '多頭' as const })),
        ]);
        fullResults = fullScan.results;
        pureResults = pureScan.results;
      } catch {
        onProgress({ type: 'date_done', date, groupASignals: 0, groupBSignals: 0 });
        perDateStats.push({ date, groupATop1Return: null, groupBTop1Return: null, groupASignals: 0, groupBSignals: 0 });
        continue;
      }

      // Group A: sort by volume descending (散戶最直覺的選法)
      const sortedA = [...pureResults].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
      // Group B: sort by compositeScore descending
      const sortedB = [...fullResults].sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0));

      // Fetch forward candles for top-N stocks from both groups
      const symbolsNeeded = new Set<string>();
      const priceMap = new Map<string, number>();
      sortedA.slice(0, maxN).forEach(r => { symbolsNeeded.add(r.symbol); priceMap.set(r.symbol, r.price); });
      sortedB.slice(0, maxN).forEach(r => { symbolsNeeded.add(r.symbol); priceMap.set(r.symbol, r.price); });

      // Also fetch for quintile analysis (all Group B signals)
      if (config.quintiles) {
        sortedB.forEach(r => { symbolsNeeded.add(r.symbol); priceMap.set(r.symbol, r.price); });
      }

      // Fetch forward candles in batches
      const forwardMap: Record<string, ForwardCandle[]> = {};
      const symbolArr = Array.from(symbolsNeeded);
      for (let i = 0; i < symbolArr.length; i += CONCURRENCY) {
        const batch = symbolArr.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(sym => fetchForwardCandles(sym, date)),
        );
        for (let j = 0; j < batch.length; j++) {
          const r = settled[j];
          forwardMap[batch[j]] = r.status === 'fulfilled' ? r.value : [];
        }
      }

      // Run SOP backtest for Group A top-N
      const aTradesForDate: BacktestTrade[] = [];
      for (const result of sortedA.slice(0, maxN)) {
        const candles = forwardMap[result.symbol] ?? [];
        const signal = scanResultToSignal(result);
        const trade = runSOPBacktest(signal, candles, PURE_ZHU_STRATEGY);
        if (trade) aTradesForDate.push(trade);
        else groupASkipped++;
      }

      // Run SOP backtest for Group B top-N
      const bTradesForDate: BacktestTrade[] = [];
      for (const result of sortedB.slice(0, maxN)) {
        const candles = forwardMap[result.symbol] ?? [];
        const signal = scanResultToSignal(result);
        const trade = runSOPBacktest(signal, candles, PURE_ZHU_STRATEGY);
        if (trade) bTradesForDate.push(trade);
        else groupBSkipped++;
      }

      // Accumulate by topN
      for (const n of config.topN) {
        const aTrades = groupATrades.get(n)!;
        const bTrades = groupBTrades.get(n)!;
        aTrades.push(...aTradesForDate.slice(0, n));
        bTrades.push(...bTradesForDate.slice(0, n));
      }

      // Quintile analysis: run SOP backtest for ALL Group B signals
      if (config.quintiles && sortedB.length >= 5) {
        for (let ri = 0; ri < sortedB.length; ri++) {
          const result = sortedB[ri];
          const rankFraction = (ri + 1) / sortedB.length;
          const candles = forwardMap[result.symbol] ?? [];
          const signal = scanResultToSignal(result);
          const trade = runSOPBacktest(signal, candles, PURE_ZHU_STRATEGY);
          if (trade) {
            quintileTrades.push({ trade, rankFraction });
          }
        }
      }

      // Per-date stats
      const aTop1 = aTradesForDate[0]?.netReturn ?? null;
      const bTop1 = bTradesForDate[0]?.netReturn ?? null;
      perDateStats.push({
        date,
        groupATop1Return: aTop1,
        groupBTop1Return: bTop1,
        groupASignals: sortedA.length,
        groupBSignals: sortedB.length,
      });

      onProgress({
        type: 'date_done',
        date,
        groupASignals: sortedA.length,
        groupBSignals: sortedB.length,
      });

      // Small delay to avoid Yahoo rate limits
      await new Promise(r => setTimeout(r, 200));
    }

    // 4. Aggregate top-N results
    const topNResults: TopNSliceResult[] = config.topN.map(n => ({
      topN: n,
      groupA: calcBacktestStats(groupATrades.get(n)!, groupASkipped),
      groupB: calcBacktestStats(groupBTrades.get(n)!, groupBSkipped),
    }));

    // 5. Quintile analysis
    const quintileRows: QuintileRow[] = config.quintiles
      ? this.buildQuintiles(quintileTrades)
      : [];

    const result: ABTestResult = {
      market: config.market,
      fromDate: config.fromDate,
      toDate: config.toDate,
      datesAnalyzed: sampledDates.length,
      topNResults,
      quintileRows,
      perDateStats,
      createdAt: new Date().toISOString(),
      config,
    };

    onProgress({ type: 'complete', result });
    return result;
  }

  private async getTradingDates(
    market: MarketId,
    from: string,
    to: string,
  ): Promise<string[]> {
    const indexSymbol = market === 'CN' ? '000001.SS' : '^TWII';
    const candles = await fetchCandlesRange(indexSymbol, from, to, 15000);
    return candles.map(c => c.date).filter(d => d >= from && d <= to);
  }

  private buildQuintiles(
    data: Array<{ trade: BacktestTrade; rankFraction: number }>,
  ): QuintileRow[] {
    const buckets: Record<string, BacktestTrade[]> = {
      Q1: [], Q2: [], Q3: [], Q4: [], Q5: [],
    };

    for (const { trade, rankFraction } of data) {
      const q = rankFraction <= 0.2 ? 'Q1'
        : rankFraction <= 0.4 ? 'Q2'
        : rankFraction <= 0.6 ? 'Q3'
        : rankFraction <= 0.8 ? 'Q4'
        : 'Q5';
      buckets[q].push(trade);
    }

    const labels: Record<string, string> = {
      Q1: 'Top 20% (Q1)',
      Q2: '20-40% (Q2)',
      Q3: '40-60% (Q3)',
      Q4: '60-80% (Q4)',
      Q5: 'Bottom 20% (Q5)',
    };

    return (['Q1', 'Q2', 'Q3', 'Q4', 'Q5'] as const).map(q => ({
      quintile: q,
      label: labels[q],
      count: buckets[q].length,
      stats: calcBacktestStats(buckets[q]),
    }));
  }
}
