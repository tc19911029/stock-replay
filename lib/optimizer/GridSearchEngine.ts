/**
 * GridSearchEngine — 網格搜索引擎
 *
 * 對策略參數空間進行網格搜索，找出回測績效最佳的參數組合。
 * 使用 AsyncGenerator 設計，方便 streaming API 逐步回傳結果。
 */

import { TaiwanScanner }      from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner }       from '@/lib/scanner/ChinaScanner';
import { runBatchBacktest, calcBacktestStats, BacktestStats, BacktestStrategyParams, BacktestTrade, DEFAULT_STRATEGY } from '@/lib/backtest/BacktestEngine';
import { analyzeForwardBatch } from '@/lib/backtest/ForwardAnalyzer';
import { StrategyThresholds, BASE_THRESHOLDS } from '@/lib/strategy/StrategyConfig';
import type { StockScanResult, MarketId, ForwardCandle } from '@/lib/scanner/types';

// ── Types ───────────────────────────────────────────────────────────────────────

export interface ParamRange {
  key:    string;       // 參數名稱
  label:  string;       // 中文標籤
  min:    number;
  max:    number;
  step:   number;
  isBacktestParam?: boolean; // true = 屬於 BacktestStrategyParams（holdDays, stopLoss 等）
}

export interface GridSearchConfig {
  paramRanges:     ParamRange[];         // 要搜索的參數範圍
  fixedThresholds: StrategyThresholds;   // 固定不動的策略參數
  backtestParams:  BacktestStrategyParams;
  testDates:       string[];             // 要回測的歷史日期
  market:          MarketId;
  stockLimit?:     number;               // 每次掃描取前 N 檔（加速）
}

export interface SearchResult {
  params:         Record<string, number>;
  stats:          BacktestStats | null;
  compositeScore: number;
  tradeCount:     number;
  winRate:        number;
  avgReturn:      number;
}

export interface SearchProgress {
  current:    number;
  total:      number;
  bestSoFar:  SearchResult | null;
  elapsedMs:  number;
}

// ── Default Param Ranges ────────────────────────────────────────────────────────

export const DEFAULT_PARAM_RANGES: ParamRange[] = [
  { key: 'minScore',       label: '最低評分 (0-6)',  min: 3,    max: 6,   step: 1 },
  { key: 'volumeRatioMin', label: '量比門檻',        min: 1.0,  max: 3.0, step: 0.5 },
  { key: 'kdMaxEntry',     label: 'KD 上限',         min: 70,   max: 95,  step: 5 },
  { key: 'holdDays',       label: '持有天數',         min: 3,    max: 15,  step: 2, isBacktestParam: true },
  { key: 'stopLoss',       label: '停損 (%)',         min: -10,  max: -3,  step: 1, isBacktestParam: true },
  { key: 'surgeScoreMin',  label: '最低飆股分',       min: 0,    max: 70,  step: 10 },
];

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** 生成單一參數的所有可能值 */
function generateValues(range: ParamRange): number[] {
  const values: number[] = [];
  const precision = range.step < 1 ? 2 : range.step < 0.1 ? 3 : 1;
  for (let v = range.min; v <= range.max + range.step * 0.01; v += range.step) {
    values.push(+v.toFixed(precision));
  }
  return values;
}

/** 生成所有參數組合（笛卡爾積） */
export function generateCombinations(ranges: ParamRange[]): Record<string, number>[] {
  if (ranges.length === 0) return [{}];

  const allValues = ranges.map(r => generateValues(r));
  const combos: Record<string, number>[] = [];

  function recurse(idx: number, current: Record<string, number>) {
    if (idx === ranges.length) {
      combos.push({ ...current });
      return;
    }
    for (const val of allValues[idx]) {
      current[ranges[idx].key] = val;
      recurse(idx + 1, current);
    }
  }
  recurse(0, {});
  return combos;
}

/** 從參數組合構建 StrategyThresholds */
function buildThresholds(
  base: StrategyThresholds,
  params: Record<string, number>,
): StrategyThresholds {
  return {
    ...base,
    ...(params.minScore       !== undefined ? { minScore: params.minScore } : {}),
    ...(params.volumeRatioMin !== undefined ? { volumeRatioMin: params.volumeRatioMin } : {}),
    ...(params.kdMaxEntry     !== undefined ? { kdMaxEntry: params.kdMaxEntry } : {}),
    ...(params.kbarMinBodyPct !== undefined ? { kbarMinBodyPct: params.kbarMinBodyPct } : {}),
    ...(params.deviationMax   !== undefined ? { deviationMax: params.deviationMax } : {}),
  };
}

/** 從參數組合構建 BacktestStrategyParams */
function buildBacktestParams(
  base: BacktestStrategyParams,
  params: Record<string, number>,
): BacktestStrategyParams {
  return {
    ...base,
    ...(params.holdDays !== undefined ? { holdDays: params.holdDays } : {}),
    ...(params.stopLoss !== undefined ? { stopLoss: params.stopLoss / 100 } : {}), // -7 → -0.07
  };
}

/** 計算複合評分 (0-100) */
export function computeCompositeScore(stats: BacktestStats | null): number {
  if (!stats || stats.count < 5) return 0;

  const winRateNorm   = Math.min(stats.winRate / 100, 1);           // 0-1
  const pfNorm        = Math.min((stats.profitFactor ?? 0) / 5, 1); // 0-1
  const sharpeNorm    = Math.min(Math.max((stats.sharpeRatio ?? 0) + 1, 0) / 3, 1); // -1~2 → 0-1
  const tradeNorm     = Math.min(stats.count / 100, 1);             // 越多交易越好（防過擬合）
  const coverageNorm  = Math.min(stats.coverageRate / 100, 1);

  return +(
    winRateNorm  * 30 +
    pfNorm       * 25 +
    sharpeNorm   * 20 +
    tradeNorm    * 15 +
    coverageNorm * 10
  ).toFixed(2);
}

// ── Main Engine ─────────────────────────────────────────────────────────────────

/**
 * 對單一參數組合執行掃描+回測
 */
async function evaluateCombo(
  params:       Record<string, number>,
  config:       GridSearchConfig,
  abortSignal?: AbortSignal,
): Promise<SearchResult> {
  const thresholds    = buildThresholds(config.fixedThresholds, params);
  const btParams      = buildBacktestParams(config.backtestParams, params);
  const surgeScoreMin = params.surgeScoreMin ?? 0;

  const allTrades: BacktestTrade[] = [];
  let totalSkipped = 0;

  for (const date of config.testDates) {
    if (abortSignal?.aborted) break;

    try {
      // 1. Scan
      const scanner = config.market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
      const { results } = await scanner.scanListAtDate(
        [], // empty = use full list from scanner's getStockList
        date,
        thresholds,
      );

      // 2. Filter by surge score if specified
      let filtered = results;
      if (surgeScoreMin > 0) {
        filtered = results.filter(r => (r.surgeScore ?? 0) >= surgeScoreMin);
      }
      if (config.stockLimit && filtered.length > config.stockLimit) {
        filtered = filtered.slice(0, config.stockLimit);
      }

      if (filtered.length === 0) continue;

      // 3. Fetch forward candles
      const forwardPayload = filtered.map(r => ({
        symbol: r.symbol, name: r.name, scanPrice: r.price,
      }));
      const performance = await analyzeForwardBatch(forwardPayload, date);

      // 4. Build forward candles map
      const candlesMap: Record<string, ForwardCandle[]> = {};
      for (const p of performance) {
        candlesMap[p.symbol] = p.forwardCandles;
      }

      // 5. Backtest
      const { trades, skippedCount } = runBatchBacktest(filtered, candlesMap, btParams);
      allTrades.push(...trades);
      totalSkipped += skippedCount;
    } catch {
      // Single date failure → skip, don't crash
      totalSkipped++;
    }
  }

  const stats = calcBacktestStats(allTrades, totalSkipped);
  const score = computeCompositeScore(stats);

  return {
    params,
    stats,
    compositeScore: score,
    tradeCount:     stats?.count ?? 0,
    winRate:        stats?.winRate ?? 0,
    avgReturn:      stats?.avgNetReturn ?? 0,
  };
}

/**
 * 主搜索函數 — AsyncGenerator，每完成一組合 yield 一次
 */
export async function* gridSearch(
  config:       GridSearchConfig,
  abortSignal?: AbortSignal,
): AsyncGenerator<{ result: SearchResult; progress: SearchProgress }> {
  const combos = generateCombinations(config.paramRanges);
  const startTime = Date.now();
  let bestSoFar: SearchResult | null = null;

  for (let i = 0; i < combos.length; i++) {
    if (abortSignal?.aborted) break;

    const result = await evaluateCombo(combos[i], config, abortSignal);

    if (!bestSoFar || result.compositeScore > bestSoFar.compositeScore) {
      bestSoFar = result;
    }

    yield {
      result,
      progress: {
        current:   i + 1,
        total:     combos.length,
        bestSoFar,
        elapsedMs: Date.now() - startTime,
      },
    };
  }
}
