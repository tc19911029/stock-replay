/**
 * 策略優化執行器
 * 負責跑回測、切分 Train/Val/Test、Walk-Forward、迭代優化
 */

import type {
  StrategyVersion, StrategyParams, BacktestMetrics,
  SplitResult, Experiment, DiagnosticsReport,
} from './types';
import { DEFAULT_STRATEGY_PARAMS } from './types';
import {
  initBaselineVersion, createVersion, recordExperiment,
  saveDiagnostics, getVersion,
} from './StrategyRegistry';
import { generateDiagnostics } from './StrategyDiagnostics';

// ── API-based backtest runner ─────────────────────────────────────────────

interface BacktestAPIResult {
  winRate: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  totalPnL: number;
  totalReturnPct: number;
  avgTradeReturn: number;
  medianTradeReturn: number;
  maxWin: number;
  maxLoss: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  sharpeApprox: number;
  avgTradesPerDay: number;
  allTrades: any[];
  dailyResults: any[];
}

/** 呼叫 signal-backtest API（支援 server-side 和 client-side） */
async function runBacktestAPI(
  symbol: string,
  days: number,
  timeframe: string,
  params: StrategyParams,
  baseUrl?: string,
): Promise<BacktestAPIResult> {
  const path = `/api/daytrade/signal-backtest?symbol=${symbol}&days=${days}&timeframe=${timeframe}&capital=1000000&stopLoss=${params.stopLossPct}&takeProfit=${params.takeProfitPct}&buyThreshold=${params.buyScoreThreshold}&sellThreshold=${params.sellScoreThreshold}`;

  const url = baseUrl ? `${baseUrl}${path}` : path;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Backtest API error: ${res.status} ${err}`);
  }
  return res.json();
}

/** API 結果 → BacktestMetrics */
function toMetrics(r: BacktestAPIResult): BacktestMetrics {
  const stopLossCount = r.allTrades.filter((t: any) => t.exitReason === '停損').length;
  const takeProfitCount = r.allTrades.filter((t: any) => t.exitReason === '停利').length;

  return {
    totalTrades: r.totalTrades,
    winCount: r.winCount,
    lossCount: r.lossCount,
    winRate: r.winRate,
    totalPnL: r.totalPnL,
    totalReturnPct: r.totalReturnPct,
    avgTradeReturn: r.avgTradeReturn,
    medianTradeReturn: r.medianTradeReturn,
    maxWin: r.maxWin,
    maxLoss: r.maxLoss,
    avgWin: r.avgWin,
    avgLoss: r.avgLoss,
    profitFactor: r.profitFactor,
    sharpe: r.sharpeApprox,
    maxDrawdown: Math.abs(Math.min(0, ...r.dailyResults.map((d: any) => d.totalPnL))),
    avgMFE: 0, // TODO: calculate from trades
    avgMAE: 0,
    stopLossRate: r.totalTrades > 0 ? Math.round((stopLossCount / r.totalTrades) * 100) : 0,
    takeProfitRate: r.totalTrades > 0 ? Math.round((takeProfitCount / r.totalTrades) * 100) : 0,
    avgTradesPerDay: r.avgTradesPerDay,
    avgSignalsPerDay: r.avgTradesPerDay * 2, // approx
  };
}

// ── Train/Val/Test split ─────────────────────────────────────────────────

/**
 * 用不同天數切分 train/val/test
 * 例如 60 天 → train 前30天, val 中15天, test 後15天
 */
export async function runSplitBacktest(
  symbol: string,
  totalDays: number,
  timeframe: string,
  params: StrategyParams,
  baseUrl?: string,
): Promise<SplitResult> {
  // 切分比例: 50% train, 25% val, 25% test
  // 但 Yahoo API 回傳的是近 N 天，我們用不同天數模擬切分
  const trainDays = Math.max(5, Math.floor(totalDays * 0.5));
  const valDays = Math.max(3, Math.floor(totalDays * 0.25));
  const testDays = Math.max(3, totalDays - trainDays - valDays);

  // 跑完整期間
  const fullResult = await runBacktestAPI(symbol, totalDays, timeframe, params, baseUrl);
  const fullTrades = fullResult.allTrades;
  const fullDays = fullResult.dailyResults;

  // 切分 daily results
  const trainDaily = fullDays.slice(0, trainDays);
  const valDaily = fullDays.slice(trainDays, trainDays + valDays);
  const testDaily = fullDays.slice(trainDays + valDays);

  const metricsFromDays = (days: any[]): BacktestMetrics => {
    const trades = days.flatMap((d: any) => d.trades);
    const wins = trades.filter((t: any) => t.pnl > 0);
    const losses = trades.filter((t: any) => t.pnl <= 0);
    const returns = trades.map((t: any) => t.returnPct);
    const sortedRet = [...returns].sort((a: number, b: number) => a - b);
    const grossProfit = wins.reduce((s: number, t: any) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s: number, t: any) => s + t.pnl, 0));

    return {
      totalTrades: trades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: trades.length > 0 ? Math.round((wins.length / trades.length) * 100) : 0,
      totalPnL: trades.reduce((s: number, t: any) => s + t.pnl, 0),
      totalReturnPct: 0,
      avgTradeReturn: returns.length > 0 ? returns.reduce((a: number, b: number) => a + b, 0) / returns.length : 0,
      medianTradeReturn: sortedRet.length > 0 ? sortedRet[Math.floor(sortedRet.length / 2)] : 0,
      maxWin: returns.length > 0 ? Math.max(...returns) : 0,
      maxLoss: returns.length > 0 ? Math.min(...returns) : 0,
      avgWin: wins.length > 0 ? wins.reduce((s: number, t: any) => s + t.returnPct, 0) / wins.length : 0,
      avgLoss: losses.length > 0 ? losses.reduce((s: number, t: any) => s + t.returnPct, 0) / losses.length : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      sharpe: 0,
      maxDrawdown: 0,
      avgMFE: 0, avgMAE: 0,
      stopLossRate: trades.length > 0 ? Math.round(trades.filter((t: any) => t.exitReason === '停損').length / trades.length * 100) : 0,
      takeProfitRate: trades.length > 0 ? Math.round(trades.filter((t: any) => t.exitReason === '停利').length / trades.length * 100) : 0,
      avgTradesPerDay: days.length > 0 ? trades.length / days.length : 0,
      avgSignalsPerDay: 0,
    };
  };

  const train = metricsFromDays(trainDaily);
  const validation = metricsFromDays(valDaily);
  const test = metricsFromDays(testDaily);

  // 一致性：train 和 val 勝率差距越小越好
  const wrDiff = Math.abs(train.winRate - validation.winRate);
  const consistency = Math.max(0, 1 - wrDiff / 50);

  // 過擬合風險：train >> val 就是過擬合
  const overfitRisk = train.winRate > validation.winRate + 15 ? 0.8 :
    train.winRate > validation.winRate + 10 ? 0.5 :
    train.winRate > validation.winRate + 5 ? 0.3 : 0.1;

  return { train, validation, test, consistency, overfitRisk };
}

// ── Full optimization iteration ─────────────────────────────────────────

export interface IterationResult {
  version: StrategyVersion;
  experiment: Experiment;
  diagnostics: DiagnosticsReport;
}

/** 跑一輪完整的優化迭代 */
export async function runIteration(
  symbol: string,
  days: number,
  timeframe: string,
  versionId?: string,
  baseUrl?: string,
): Promise<IterationResult> {
  // 確保有基線版本
  initBaselineVersion();

  const version = versionId ? getVersion(versionId)! : initBaselineVersion();
  const expId = `exp-${version.id}-${Date.now()}`;

  // 記錄實驗開始
  const exp: Experiment = {
    id: expId,
    versionId: version.id,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'running',
    metrics: null,
    splitResults: null,
    diagnostics: null,
    comparedTo: null,
    improvement: null,
  };
  recordExperiment(exp);

  try {
    // 跑回測
    const result = await runBacktestAPI(symbol, days, timeframe, version.params, baseUrl);
    const metrics = toMetrics(result);

    // 跑 train/val/test split（如果天數夠多）
    let splitResults: SplitResult | undefined;
    if (days >= 15) {
      splitResults = await runSplitBacktest(symbol, days, timeframe, version.params, baseUrl);
    }

    // 產生診斷
    const diag = generateDiagnostics(
      version.id,
      metrics,
      result.allTrades.map((t: any) => ({
        entrySignal: t.entrySignal,
        returnPct: t.returnPct,
        pnl: t.pnl,
        exitReason: t.exitReason,
        holdBars: t.holdBars,
      })),
      version.params,
      splitResults,
    );

    // 更新實驗
    exp.completedAt = new Date().toISOString();
    exp.status = 'completed';
    exp.metrics = metrics;
    exp.splitResults = splitResults ?? null;
    exp.diagnostics = diag;
    recordExperiment(exp);
    saveDiagnostics(diag);

    return { version, experiment: exp, diagnostics: diag };
  } catch (e) {
    exp.status = 'failed';
    exp.completedAt = new Date().toISOString();
    recordExperiment(exp);
    throw e;
  }
}

/** 根據診斷建議自動建立新版本 */
export function applyTopSuggestion(
  diagnostics: DiagnosticsReport,
  currentVersion: StrategyVersion,
): StrategyVersion | null {
  if (diagnostics.suggestions.length === 0) return null;

  const topSuggestion = diagnostics.suggestions[0];

  return createVersion(
    topSuggestion.description.slice(0, 20) + '...',
    topSuggestion.description,
    topSuggestion.paramChanges,
    [`基於 ${currentVersion.id} 的診斷建議`, topSuggestion.description],
    currentVersion.id,
  );
}
