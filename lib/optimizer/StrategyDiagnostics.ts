/**
 * 策略自動診斷模組
 * 分析回測結果，找出問題，提出優化建議
 */

import type {
  BacktestMetrics, DiagnosticsReport, DiagnosticIssue,
  OptimizationSuggestion, RuleDiagnostic, StrategyParams,
} from './types';

interface TradeWithRule {
  entrySignal: string;
  returnPct: number;
  pnl: number;
  exitReason: string;
  holdBars: number;
}

/** 從回測交易中診斷規則品質 */
function analyzeRules(trades: TradeWithRule[]): RuleDiagnostic[] {
  const ruleMap = new Map<string, TradeWithRule[]>();
  for (const t of trades) {
    const key = t.entrySignal || 'unknown';
    if (!ruleMap.has(key)) ruleMap.set(key, []);
    ruleMap.get(key)!.push(t);
  }

  const results: RuleDiagnostic[] = [];
  for (const [ruleId, ruleTrades] of ruleMap) {
    const wins = ruleTrades.filter(t => t.pnl > 0);
    const winRate = ruleTrades.length > 0 ? (wins.length / ruleTrades.length) * 100 : 0;
    const avgReturn = ruleTrades.length > 0
      ? ruleTrades.reduce((s, t) => s + t.returnPct, 0) / ruleTrades.length : 0;
    const contribution = ruleTrades.reduce((s, t) => s + t.pnl, 0);
    const falseSignalRate = ruleTrades.length > 0
      ? ruleTrades.filter(t => t.returnPct < -1).length / ruleTrades.length : 0;

    let grade: 'A' | 'B' | 'C' | 'D' | 'F';
    if (winRate >= 60 && avgReturn > 0.5) grade = 'A';
    else if (winRate >= 50 && avgReturn > 0) grade = 'B';
    else if (winRate >= 40 || avgReturn > -0.2) grade = 'C';
    else if (winRate >= 25) grade = 'D';
    else grade = 'F';

    let recommendation: string;
    if (grade === 'F') recommendation = '移除';
    else if (grade === 'D') recommendation = '降權或移除';
    else if (grade === 'C') recommendation = '調整參數';
    else if (grade === 'B') recommendation = '保留觀察';
    else recommendation = '保留';

    results.push({
      ruleId,
      ruleName: ruleId,
      totalTriggers: ruleTrades.length,
      winRate: Math.round(winRate),
      avgReturn,
      contribution,
      falseSignalRate: Math.round(falseSignalRate * 100),
      grade,
      recommendation,
    });
  }

  return results.sort((a, b) => b.contribution - a.contribution);
}

/** 診斷問題 */
function findIssues(metrics: BacktestMetrics, rules: RuleDiagnostic[], params: StrategyParams): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];

  // 勝率問題
  if (metrics.winRate < 30) {
    issues.push({ severity: 'critical', category: '勝率', message: `勝率極低 (${metrics.winRate}%)，訊號品質嚴重不足` });
  } else if (metrics.winRate < 45) {
    issues.push({ severity: 'warning', category: '勝率', message: `勝率偏低 (${metrics.winRate}%)，需要更嚴格的進場過濾` });
  }

  // 盈虧比
  if (metrics.profitFactor < 0.5) {
    issues.push({ severity: 'critical', category: '盈虧比', message: `盈虧比極差 (${metrics.profitFactor.toFixed(2)})，虧損遠大於獲利` });
  } else if (metrics.profitFactor < 1) {
    issues.push({ severity: 'warning', category: '盈虧比', message: `盈虧比不足 (${metrics.profitFactor.toFixed(2)})，需改善出場策略` });
  }

  // 停損觸發率
  if (metrics.stopLossRate > 60) {
    issues.push({ severity: 'critical', category: '停損', message: `停損觸發率過高 (${metrics.stopLossRate}%)，停損可能設太近` });
  } else if (metrics.stopLossRate > 40) {
    issues.push({ severity: 'warning', category: '停損', message: `停損觸發率偏高 (${metrics.stopLossRate}%)，考慮放寬停損或改善進場時機` });
  }

  // 訊號頻率
  if (metrics.avgTradesPerDay > 5) {
    issues.push({ severity: 'warning', category: '訊號頻率', message: `日均交易 ${metrics.avgTradesPerDay.toFixed(1)} 次，訊號可能過於頻繁` });
  } else if (metrics.avgTradesPerDay < 0.3) {
    issues.push({ severity: 'info', category: '訊號頻率', message: `日均交易 ${metrics.avgTradesPerDay.toFixed(1)} 次，訊號過少` });
  }

  // 平均報酬
  if (metrics.avgTradeReturn < -0.5) {
    issues.push({ severity: 'critical', category: '報酬', message: `平均報酬 ${metrics.avgTradeReturn.toFixed(2)}%，每筆交易平均虧損嚴重` });
  }

  // 假訊號
  const badRules = rules.filter(r => r.grade === 'F');
  if (badRules.length > 0) {
    issues.push({
      severity: 'warning', category: '訊號品質',
      message: `${badRules.length} 條規則品質極差 (F級)：${badRules.map(r => r.ruleId).join(', ')}`,
    });
  }

  // 回撤
  if (metrics.maxDrawdown > 10) {
    issues.push({ severity: 'critical', category: '回撤', message: `最大回撤 ${metrics.maxDrawdown.toFixed(1)}%，風險過高` });
  }

  // 多週期未啟用
  if (!params.requireMTFBullish) {
    issues.push({ severity: 'info', category: '多週期', message: '未啟用多週期共振過濾，可能接收到逆勢訊號' });
  }

  // 量能未過濾
  if (params.minVolumeRatio <= 0) {
    issues.push({ severity: 'info', category: '量能', message: '未設定量能過濾，可能買到低量假突破' });
  }

  return issues;
}

/** 產生優化建議 */
function generateSuggestions(
  metrics: BacktestMetrics,
  rules: RuleDiagnostic[],
  params: StrategyParams,
  issues: DiagnosticIssue[],
): OptimizationSuggestion[] {
  const suggestions: OptimizationSuggestion[] = [];
  let idx = 0;

  // 1. 移除差規則
  const badRules = rules.filter(r => r.grade === 'F' || r.grade === 'D');
  if (badRules.length > 0) {
    suggestions.push({
      id: `opt-${++idx}`,
      description: `停用 ${badRules.length} 條低品質規則：${badRules.map(r => r.ruleId).join(', ')}`,
      expectedImpact: '減少假訊號，提高勝率',
      paramChanges: { disabledRules: [...params.disabledRules, ...badRules.map(r => r.ruleId)] },
      priority: 'high',
    });
  }

  // 2. 提高買入門檻
  if (metrics.winRate < 40 && params.buyScoreThreshold < 70) {
    suggestions.push({
      id: `opt-${++idx}`,
      description: `提高買入訊號門檻 ${params.buyScoreThreshold} → 70`,
      expectedImpact: '減少低品質進場，預計提高勝率 5-15%',
      paramChanges: { buyScoreThreshold: 70 },
      priority: 'high',
    });
  }

  // 3. 停損調整
  if (metrics.stopLossRate > 50 && params.stopLossPct > -3) {
    suggestions.push({
      id: `opt-${++idx}`,
      description: `放寬停損 ${params.stopLossPct}% → -3%`,
      expectedImpact: '減少被洗出，降低停損觸發率',
      paramChanges: { stopLossPct: -3 },
      priority: 'high',
    });
  } else if (metrics.stopLossRate < 10 && params.stopLossPct < -1) {
    suggestions.push({
      id: `opt-${++idx}`,
      description: `收緊停損 ${params.stopLossPct}% → ${Math.max(params.stopLossPct + 1, -1)}%`,
      expectedImpact: '及早止損，減少單筆虧損',
      paramChanges: { stopLossPct: Math.max(params.stopLossPct + 1, -1) },
      priority: 'medium',
    });
  }

  // 4. 啟用多週期過濾
  if (!params.requireMTFBullish && metrics.winRate < 50) {
    suggestions.push({
      id: `opt-${++idx}`,
      description: '啟用多週期偏多過濾：只在60m偏多時接受買點',
      expectedImpact: '過濾逆勢訊號，提高勝率',
      paramChanges: { requireMTFBullish: true, mtfMinScore: 50 },
      priority: 'high',
    });
  }

  // 5. 量能過濾
  if (params.minVolumeRatio <= 0 && metrics.winRate < 50) {
    suggestions.push({
      id: `opt-${++idx}`,
      description: '加入量能過濾：量比 >= 1.2 才進場',
      expectedImpact: '過濾低量假突破',
      paramChanges: { minVolumeRatio: 1.2 },
      priority: 'medium',
    });
  }

  // 6. 時段限制
  if (params.allowedTimeRanges.length === 0 && metrics.avgTradesPerDay > 3) {
    suggestions.push({
      id: `opt-${++idx}`,
      description: '限制交易時段：只在開盤半小時和尾盤操作',
      expectedImpact: '避開盤中震盪，減少噪音交易',
      paramChanges: { allowedTimeRanges: ['09:00-09:30', '13:00-13:25'] },
      priority: 'medium',
    });
  }

  // 7. 縮小持倉
  if (metrics.maxDrawdown > 5 && params.positionSizePct > 0.3) {
    suggestions.push({
      id: `opt-${++idx}`,
      description: `縮小持倉比例 ${(params.positionSizePct * 100).toFixed(0)}% → 30%`,
      expectedImpact: '降低單筆風險，改善回撤',
      paramChanges: { positionSizePct: 0.3 },
      priority: 'low',
    });
  }

  return suggestions.sort((a, b) => {
    const p = { high: 0, medium: 1, low: 2 };
    return p[a.priority] - p[b.priority];
  });
}

/** 產生完整診斷報告 */
export function generateDiagnostics(
  versionId: string,
  metrics: BacktestMetrics,
  trades: TradeWithRule[],
  params: StrategyParams,
  splitResults?: any,
): DiagnosticsReport {
  const ruleAnalysis = analyzeRules(trades);
  const issues = findIssues(metrics, ruleAnalysis, params);
  const suggestions = generateSuggestions(metrics, ruleAnalysis, params, issues);

  const topRules = ruleAnalysis.filter(r => r.grade === 'A' || r.grade === 'B').map(r => r.ruleId);
  const worstRules = ruleAnalysis.filter(r => r.grade === 'F' || r.grade === 'D').map(r => r.ruleId);

  return {
    versionId,
    generatedAt: new Date().toISOString(),
    overallMetrics: metrics,
    splitResults: splitResults ?? null,
    ruleAnalysis,
    topRules,
    worstRules,
    issues,
    suggestions,
  };
}
