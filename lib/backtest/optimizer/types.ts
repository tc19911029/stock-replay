/**
 * Backtest Optimizer Types
 *
 * Layer 0 門檻 + 排序權重最佳化回測系統的型別定義。
 */

import type { MarketId } from '@/lib/scanner/types';

// ── Daily Candidate ─────────────────────────────────────────────────────────────

/** 每日通過 Layer 1-3 篩選的候選股（含預計算的 SOP 交易結果） */
export interface DailyCandidate {
  date:   string;       // YYYY-MM-DD
  symbol: string;
  name:   string;
  market: MarketId;

  // Layer scores
  mtfScore:         number;  // 0-4 (Layer 0)
  sixCondScore:     number;  // 0-6 (Layer 1)
  highWinRateScore: number;  // 0-30 (6 positions × 5)

  // 新排序因子（數據驅動）
  mom5d:            number;  // 5日動能 %（收盤/5日前收盤 - 1）
  distFrom60dHigh:  number;  // 離60日高點 %（收盤/60日最高 - 1，0=在高點）

  // For trade simulation
  candleIdx:  number;        // index into the stock's candle array
  _stockKey:  string;        // key into allCandles map

  // SOP trade result (pre-computed via runSOPBacktest)
  tradeResult: TradeResult | null;
}

/** 單筆交易的模擬結果 */
export interface TradeResult {
  entryDate:   string;
  entryPrice:  number;
  exitDate:    string;
  exitPrice:   number;
  netReturn:   number;    // % after fees
  grossReturn: number;    // % before fees
  holdDays:    number;
  exitReason:  string;    // 'stopLoss'|'sop_gain10BreakMA5'|'holdDays'|...
  maxDrawdown: number;    // worst unrealized loss % during hold (negative)
}

// ── Ranking ─────────────────────────────────────────────────────────────────────

/** 權重組合（排序因子：高勝率 + MTF） */
export interface WeightCombo {
  name: string;
  wH: number;   // highWinRate weight
  wM: number;   // MTF weight (固定0，只篩選不排序)
}

/** 排序後的候選股（增加 finalScore 和 rank） */
export interface RankedCandidate extends DailyCandidate {
  finalScore: number;
  rank:       number;   // 1-based
}

// ── Metrics ─────────────────────────────────────────────────────────────────────

/** 策略績效指標 */
export interface StrategyMetrics {
  tradeCount:       number;
  noCandidateDays:  number;

  // Core
  avgReturn:      number;         // avg netReturn %
  totalReturn:    number;         // sum of netReturn %
  compoundReturn: number;         // product of (1+r/100) - 1
  annualReturn:   number;         // annualized compound
  winRate:        number;         // % of trades with netReturn > 0
  maxDrawdown:    number;         // equity curve peak-to-trough (negative)

  // Risk
  avgWin:        number;
  avgLoss:       number;
  profitFactor:  number;
  sharpeRatio:   number | null;
  sortinoRatio:  number | null;
  avgHoldDays:   number;

  // Top-1 quality
  top1BeatsTop2Pct:   number;     // % of days Top-1 return > Top-2
  top1BeatsTop3Pct:   number;     // % of days Top-1 return > Top-3
  top1BestInTop5Pct:  number;     // % of days Top-1 has best return in top 5
  rankReturnSpearman: number | null;

  // Breakdown
  byYear:          Record<string, YearMetrics>;
  exitReasonDist:  Record<string, number>;
}

export interface YearMetrics {
  avgReturn: number;
  winRate:   number;
  count:     number;
}

// ── Config ──────────────────────────────────────────────────────────────────────

export interface OptimizerConfig {
  market:        MarketId | 'ALL';
  backtestStart: string;
  backtestMid:   string;   // train/test split
  backtestEnd:   string;
  outputJson:    string | null;
}

// ── Phase Results ───────────────────────────────────────────────────────────────

export interface PhaseAResult {
  results: { factor: string; metrics: StrategyMetrics }[];
}

export interface PhaseBResult {
  results: {
    threshold:         number;
    avgCandidateCount: number;
    metrics:           StrategyMetrics;
  }[];
}

export interface PhaseCResult {
  grid: {
    threshold: number;
    combo:     WeightCombo;
    metrics:   StrategyMetrics;
  }[];
  top10: {
    threshold: number;
    combo:     WeightCombo;
    metrics:   StrategyMetrics;
  }[];
}

export interface PhaseDResult {
  topNComparison: { topN: number; metrics: StrategyMetrics }[];
  randomBaseline: StrategyMetrics;
  spearmanValues: number[];   // daily Spearman correlations
  avgSpearman:    number;
}

export interface WalkForwardResult {
  strategy:        { threshold: number; combo: WeightCombo };
  trainMetrics:    StrategyMetrics;
  testMetrics:     StrategyMetrics;
  isOverfit:       boolean;
  efficiencyRatio: number;   // test avgReturn / train avgReturn
}

// ── Output ──────────────────────────────────────────────────────────────────────

export interface DailyDetail {
  date:       string;
  symbol:     string;
  name:       string;
  entryPrice: number;
  exitPrice:  number;
  netReturn:  number;
  exitReason: string;
  holdDays:   number;
  cumReturn:  number;   // cumulative compound return
}

export interface OptimizerOutput {
  config:       OptimizerConfig;
  phaseA:       PhaseAResult;
  phaseB:       PhaseBResult;
  phaseC:       PhaseCResult;
  phaseD:       PhaseDResult;
  walkForward:  WalkForwardResult;
  bestStrategy: { mtfThreshold: number; combo: WeightCombo; metrics: StrategyMetrics };
  dailyDetail:  DailyDetail[];
  equityCurve:  { date: string; equity: number }[];
}
