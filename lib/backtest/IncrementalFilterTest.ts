/**
 * IncrementalFilterTest.ts — 增量式 Filter A/B 測試
 *
 * 核心思路：
 * 以純朱老師 SOP（scanOnePure）+ 朱老師獲利方程式出場為 baseline，
 * 每次只加一個 filter，比較 Sharpe 是否改善。
 *
 * 邊際貢獻 > 0 → filter 有用，保留
 * 邊際貢獻 ≤ 0 → filter 沒用或有害，拿掉
 */

import type { StockScanResult, ForwardCandle } from '@/lib/scanner/types';
import {
  runSOPBacktest,
  calcBacktestStats,
  scanResultToSignal,
  DEFAULT_ZHU_EXIT,
  ZHU_PROFIT_FORMULA_STRATEGY,
  type BacktestTrade,
  type BacktestStats,
  type ZhuExitParams,
  type BacktestStrategyParams,
} from './BacktestEngine';

// ── Filter 定義 ────────────────────────────────────────────────────────────────

export interface FilterDefinition {
  id: string;
  name: string;
  description: string;
  /** true = 保留此股票，false = 淘汰 */
  apply: (result: StockScanResult) => boolean;
}

/** 系統內建的可測試 filter（對應 scanOne 中篩選階段的各道 filter） */
export const TESTABLE_FILTERS: FilterDefinition[] = [
  {
    id: 'surge-gate',
    name: 'surgeScore 門檻',
    description: '台股 surgeScore ≥ 40 / 陸股 ≥ 30',
    apply: (r) => {
      const min = r.market === 'CN' ? 30 : 40;
      return (r.surgeScore ?? 0) >= min;
    },
  },
  {
    id: 'overheat-composite',
    name: '複合過熱檢查',
    description: 'retailSentiment > 80 視為過熱',
    apply: (r) => (r.retailSentiment ?? 50) <= 80,
  },
  {
    id: 'hist-winrate',
    name: '歷史勝率 ≥ 50%',
    description: '過去120天同類信號勝率需 ≥ 50%',
    apply: (r) => r.histWinRate === undefined || r.histWinRate >= 50,
  },
  {
    id: 'min-volume',
    name: '最低成交量',
    description: '台股 ≥ 1000張 / 陸股 ≥ 50000手',
    apply: (r) => {
      const min = r.market === 'CN' ? 50000 : 1000;
      return r.volume >= min;
    },
  },
  {
    id: 'end-stage',
    name: '末升段不進場',
    description: '趨勢位置包含「末升」則淘汰',
    apply: (r) => !r.trendPosition.includes('末升'),
  },
  {
    id: 'elimination-penalty',
    name: '淘汰法扣分 > -10',
    description: '朱老師淘汰法扣分超過 -10 則淘汰',
    apply: (r) => (r.eliminationPenalty ?? 0) > -10,
  },
  {
    id: 'smart-money-gate',
    name: 'smartMoneyScore ≥ 40',
    description: '主力買賣力道分數門檻',
    apply: (r) => (r.smartMoneyScore ?? 0) >= 40,
  },
  {
    id: 'breakthrough-quality',
    name: '突破品質 ≥ B',
    description: 'breakthroughScore ≥ 50（B 級以上）',
    apply: (r) => (r.breakthroughScore ?? 50) >= 50,
  },
  {
    id: 'high-winrate-entry',
    name: '高勝率進場位置',
    description: '至少匹配一個朱老師高勝率進場型態',
    apply: (r) => (r.highWinRateTypes?.length ?? 0) > 0,
  },
];

// ── 單一 filter 測試結果 ────────────────────────────────────────────────────────

export interface FilterTestResult {
  filterId: string;
  filterName: string;
  signalCount: number;
  avgHoldDays: number;
  stats: BacktestStats | null;
  /** 邊際貢獻 = 此 filter 的 Sharpe - baseline 的 Sharpe */
  marginalSharpe: number | null;
  /** 結論：'keep' | 'remove' | 'neutral' */
  verdict: 'keep' | 'remove' | 'neutral';
}

export interface IncrementalTestResult {
  baseline: {
    signalCount: number;
    avgHoldDays: number;
    stats: BacktestStats | null;
  };
  filters: FilterTestResult[];
  /** 有正貢獻的 filter ID 列表 */
  keepFilters: string[];
}

// ── 測試主邏輯 ──────────────────────────────────────────────────────────────────

/**
 * 執行增量式 filter A/B 測試
 *
 * @param baselineResults  純朱老師 SOP 選出的候選股（scanOnePure 結果）
 * @param forwardCandlesMap 前向K線資料
 * @param filters          要測試的 filter 列表（預設用 TESTABLE_FILTERS）
 * @param strategy         回測策略參數
 * @param zhuExit          朱老師出場參數
 */
export function runIncrementalFilterTest(
  baselineResults:    StockScanResult[],
  forwardCandlesMap:  Record<string, ForwardCandle[]>,
  filters:            FilterDefinition[] = TESTABLE_FILTERS,
  strategy:           BacktestStrategyParams = ZHU_PROFIT_FORMULA_STRATEGY,
  zhuExit:            ZhuExitParams = DEFAULT_ZHU_EXIT,
): IncrementalTestResult {
  // ── Baseline：純 SOP 不加任何 filter ──
  const baselineTrades = runFilteredBacktest(baselineResults, forwardCandlesMap, strategy, zhuExit);
  const baselineStats = calcBacktestStats(baselineTrades, 0);
  const baselineSharpe = baselineStats?.sharpeRatio ?? null;
  const baselineAvgHold = baselineTrades.length > 0
    ? baselineTrades.reduce((s, t) => s + t.holdDays, 0) / baselineTrades.length
    : 0;

  // ── 逐一測試每個 filter ──
  const filterResults: FilterTestResult[] = filters.map((filter) => {
    const filtered = baselineResults.filter(filter.apply);
    const trades = runFilteredBacktest(filtered, forwardCandlesMap, strategy, zhuExit);
    const stats = calcBacktestStats(trades, 0);
    const sharpe = stats?.sharpeRatio ?? null;
    const avgHold = trades.length > 0
      ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length
      : 0;

    const marginal = (sharpe !== null && baselineSharpe !== null)
      ? +(sharpe - baselineSharpe).toFixed(4)
      : null;

    const verdict: 'keep' | 'remove' | 'neutral' =
      marginal === null ? 'neutral'
      : marginal > 0.01 ? 'keep'
      : marginal < -0.01 ? 'remove'
      : 'neutral';

    return {
      filterId: filter.id,
      filterName: filter.name,
      signalCount: trades.length,
      avgHoldDays: +avgHold.toFixed(1),
      stats,
      marginalSharpe: marginal,
      verdict,
    };
  });

  return {
    baseline: {
      signalCount: baselineTrades.length,
      avgHoldDays: +baselineAvgHold.toFixed(1),
      stats: baselineStats,
    },
    filters: filterResults,
    keepFilters: filterResults
      .filter((f) => f.verdict === 'keep')
      .map((f) => f.filterId),
  };
}

// ── 內部：用 SOP 出場跑回測 ────────────────────────────────────────────────────

function runFilteredBacktest(
  results:           StockScanResult[],
  forwardCandlesMap: Record<string, ForwardCandle[]>,
  strategy:          BacktestStrategyParams,
  zhuExit:           ZhuExitParams,
): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  for (const result of results) {
    const candles = forwardCandlesMap[result.symbol] ?? [];
    if (candles.length === 0) continue;
    const signal = scanResultToSignal(result);
    const trade = runSOPBacktest(signal, candles, strategy, zhuExit);
    if (trade) trades.push(trade);
  }
  return trades;
}
