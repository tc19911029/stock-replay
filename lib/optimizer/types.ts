/**
 * 策略優化框架 — 型別定義
 */

// ── 策略版本 ──────────────────────────────────────────────────────────────────

export interface StrategyVersion {
  id: string;                    // e.g. "v1.0", "v1.1", "v2.0"
  name: string;                  // e.g. "基線版", "量能過濾版"
  description: string;           // 改了什麼
  createdAt: string;             // ISO datetime
  parentId: string | null;       // 基於哪個版本
  params: StrategyParams;        // 策略參數
  changelog: string[];           // 每條改動
}

export interface StrategyParams {
  // 訊號門檻
  buyScoreThreshold: number;     // 買入訊號最低分數 (0-100)
  sellScoreThreshold: number;    // 賣出訊號最低分數 (0-100)

  // 停損停利
  stopLossPct: number;           // e.g. -2
  takeProfitPct: number;         // e.g. 3

  // 持倉
  positionSizePct: number;       // 每次買入資金比例 (0-1)
  maxPositions: number;          // 最大同時持倉數

  // 規則開關
  enabledRules: string[];        // 啟用的規則 ID
  disabledRules: string[];       // 停用的規則 ID

  // 多週期過濾
  requireMTFBullish: boolean;    // 是否要求多週期偏多才買
  mtfMinScore: number;           // 多週期共振最低分

  // 量能過濾
  minVolumeRatio: number;        // 最低量比 (相對5日均量)

  // 時段過濾
  allowedTimeRanges: string[];   // e.g. ["09:00-10:30", "13:00-13:25"]

  // 額外過濾
  minCandleBody: number;         // 最小K棒實體比例
  maxSpreadPct: number;          // 最大價差%

  // 自訂參數
  custom: Record<string, number | string | boolean>;
}

// ── 回測結果 ──────────────────────────────────────────────────────────────────

export interface BacktestMetrics {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  totalPnL: number;
  totalReturnPct: number;
  avgTradeReturn: number;
  medianTradeReturn: number;
  maxWin: number;
  maxLoss: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdown: number;
  avgMFE: number;               // 平均最大順行幅度
  avgMAE: number;               // 平均最大逆行幅度
  stopLossRate: number;         // 停損觸發率
  takeProfitRate: number;       // 停利達成率
  avgTradesPerDay: number;
  avgSignalsPerDay: number;
}

export interface SplitResult {
  train: BacktestMetrics;
  validation: BacktestMetrics;
  test: BacktestMetrics;
  consistency: number;          // train vs validation 一致性 (0-1)
  overfitRisk: number;          // 過擬合風險 (0-1)
}

// ── 診斷報告 ──────────────────────────────────────────────────────────────────

export interface RuleDiagnostic {
  ruleId: string;
  ruleName: string;
  totalTriggers: number;
  winRate: number;
  avgReturn: number;
  contribution: number;         // 對整體績效的貢獻 (正=好, 負=差)
  falseSignalRate: number;      // 假訊號率
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  recommendation: string;       // "保留" | "調整" | "移除" | "降權"
}

export interface TimeframeDiagnostic {
  timeframe: string;
  winRate: number;
  avgReturn: number;
  tradeCount: number;
  recommendation: string;
}

export interface DiagnosticsReport {
  versionId: string;
  generatedAt: string;
  overallMetrics: BacktestMetrics;
  splitResults: SplitResult | null;

  // 規則診斷
  ruleAnalysis: RuleDiagnostic[];
  topRules: string[];            // 貢獻最高的規則
  worstRules: string[];          // 拖累最大的規則

  // 問題列表
  issues: DiagnosticIssue[];

  // 優化建議
  suggestions: OptimizationSuggestion[];
}

export interface DiagnosticIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;             // "勝率" | "停損" | "訊號品質" | "過擬合" | ...
  message: string;
  data?: Record<string, number | string>;
}

export interface OptimizationSuggestion {
  id: string;
  description: string;
  expectedImpact: string;       // "提高勝率5-10%" | "減少假訊號"
  paramChanges: Partial<StrategyParams>;
  priority: 'high' | 'medium' | 'low';
}

// ── 實驗追蹤 ──────────────────────────────────────────────────────────────────

export interface Experiment {
  id: string;
  versionId: string;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'failed';
  metrics: BacktestMetrics | null;
  splitResults: SplitResult | null;
  diagnostics: DiagnosticsReport | null;
  comparedTo: string | null;     // 對比版本 ID
  improvement: {
    winRate: number;
    avgReturn: number;
    profitFactor: number;
    sharpe: number;
  } | null;
}

// ── 預設策略參數 ──────────────────────────────────────────────────────────────

export const DEFAULT_STRATEGY_PARAMS: StrategyParams = {
  buyScoreThreshold: 60,
  sellScoreThreshold: 60,
  stopLossPct: -2,
  takeProfitPct: 3,
  positionSizePct: 0.5,
  maxPositions: 1,
  enabledRules: [],              // 空 = 全部啟用
  disabledRules: [],
  requireMTFBullish: false,
  mtfMinScore: 0,
  minVolumeRatio: 0,
  allowedTimeRanges: [],         // 空 = 不限制
  minCandleBody: 0,
  maxSpreadPct: 10,
  custom: {},
};
