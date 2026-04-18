/**
 * Phase Runner — 四階段回測 + Walk-Forward 驗證
 *
 * Phase A: 單因子排序能力
 * Phase B: Layer 0 (MTF) 門檻測試
 * Phase C: 權重組合網格搜索
 * Phase D: 對照組比較 + Spearman 相關性
 * Walk-Forward: 訓練/驗證分割
 */

import type {
  DailyCandidate,
  WeightCombo,
  StrategyMetrics,
  PhaseAResult,
  PhaseBResult,
  PhaseCResult,
  PhaseDResult,
  WalkForwardResult,
} from './types';
import { SINGLE_FACTOR_COMBOS, GRID_COMBOS, MTF_THRESHOLDS } from './rankingEngine';
import { calcTop1Metrics, calcMetricsFromReturns, avgCandidateCount } from './metricsCalculator';

// ── Phase A: Single Factor Ranking Power ────────────────────────────────────────

export function runPhaseA(
  dailyCandidates: Map<string, DailyCandidate[]>,
  days:            string[],
): PhaseAResult {
  console.log('\n══ Phase A: 單因子排序能力測試 ══\n');

  const results: PhaseAResult['results'] = [];

  for (const combo of SINGLE_FACTOR_COMBOS) {
    console.log(`   測試: ${combo.name} ...`);
    const metrics = calcTop1Metrics(dailyCandidates, days, combo, 0, 1);
    results.push({ factor: combo.name, metrics });
  }

  return { results };
}

// ── Phase B: Layer 0 Threshold Test ─────────────────────────────────────────────

export function runPhaseB(
  dailyCandidates: Map<string, DailyCandidate[]>,
  days:            string[],
): PhaseBResult {
  console.log('\n══ Phase B: MTF 門檻測試 ══\n');

  // 使用等權基準 (1:1:1)
  const baseCombo: WeightCombo = { name: '等權1:1', wH: 1, wM: 1 };
  const results: PhaseBResult['results'] = [];

  for (const threshold of MTF_THRESHOLDS) {
    console.log(`   MTF≥${threshold} ...`);
    const avgCount = avgCandidateCount(dailyCandidates, days, threshold);
    const metrics  = calcTop1Metrics(dailyCandidates, days, baseCombo, threshold, 1);
    results.push({ threshold, avgCandidateCount: avgCount, metrics });
  }

  return { results };
}

// ── Phase C: Weight Grid Search ─────────────────────────────────────────────────

export function runPhaseC(
  dailyCandidates: Map<string, DailyCandidate[]>,
  days:            string[],
): PhaseCResult {
  console.log('\n══ Phase C: 權重組合網格搜索 ══\n');

  const grid: PhaseCResult['grid'] = [];
  const total = MTF_THRESHOLDS.length * GRID_COMBOS.length;
  let count = 0;

  for (const threshold of MTF_THRESHOLDS) {
    for (const combo of GRID_COMBOS) {
      count++;
      if (count % 10 === 0) console.log(`   進度: ${count}/${total}`);
      const metrics = calcTop1Metrics(dailyCandidates, days, combo, threshold, 1);
      grid.push({ threshold, combo, metrics });
    }
  }

  // Top 10 by avgReturn
  const top10 = [...grid]
    .sort((a, b) => b.metrics.avgReturn - a.metrics.avgReturn)
    .slice(0, 10);

  return { grid, top10 };
}

// ── Phase D: Comparison Groups ──────────────────────────────────────────────────

export function runPhaseD(
  dailyCandidates: Map<string, DailyCandidate[]>,
  days:            string[],
  bestCombo:       WeightCombo,
  bestThreshold:   number,
): PhaseDResult {
  console.log('\n══ Phase D: 對照組比較 ══\n');

  // Top-1 vs Top-3 vs Top-5
  const topNComparison: PhaseDResult['topNComparison'] = [];
  for (const topN of [1, 3, 5]) {
    console.log(`   Top-${topN} ...`);
    const metrics = calcTop1Metrics(dailyCandidates, days, bestCombo, bestThreshold, topN);
    topNComparison.push({ topN, metrics });
  }

  // Random baseline: pick random candidate each day
  console.log('   隨機基線 ...');
  const randomMetrics = calcRandomBaseline(dailyCandidates, days, bestThreshold);

  // Spearman values collected from Top-1 metrics
  const top1Metrics = topNComparison.find(t => t.topN === 1)?.metrics;
  const spearmanValues: number[] = [];  // already computed inside calcTop1Metrics
  const avgSpearman = top1Metrics?.rankReturnSpearman ?? 0;

  return {
    topNComparison,
    randomBaseline: randomMetrics,
    spearmanValues,
    avgSpearman,
  };
}

/**
 * 隨機基線：每天從候選股中隨機選一檔
 * 使用固定 seed 保證可重現
 */
function calcRandomBaseline(
  dailyCandidates: Map<string, DailyCandidate[]>,
  days:            string[],
  mtfThreshold:    number,
): StrategyMetrics {
  const returns:      number[] = [];
  const holdDaysList: number[] = [];
  const exitReasons:  string[] = [];
  let noCandidateDays = 0;
  let seed = 42;

  for (const date of days) {
    const candidates = dailyCandidates.get(date);
    if (!candidates || candidates.length === 0) {
      noCandidateDays++;
      continue;
    }

    const filtered = candidates.filter(c => c.mtfScore >= mtfThreshold);
    if (filtered.length === 0) {
      noCandidateDays++;
      continue;
    }

    // Simple deterministic pseudo-random
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const idx = seed % filtered.length;
    const pick = filtered[idx];

    if (pick.tradeResult) {
      returns.push(pick.tradeResult.netReturn);
      holdDaysList.push(pick.tradeResult.holdDays);
      exitReasons.push(pick.tradeResult.exitReason);
    }
  }

  return calcMetricsFromReturns(returns, holdDaysList, exitReasons, noCandidateDays);
}

// ── Walk-Forward Validation ─────────────────────────────────────────────────────

export function runWalkForward(
  dailyCandidates: Map<string, DailyCandidate[]>,
  trainDays:       string[],
  testDays:        string[],
): WalkForwardResult {
  console.log('\n══ Walk-Forward 驗證 ══\n');

  // Find best strategy on training data
  console.log('   訓練期: 尋找最佳策略 ...');
  let bestAvg = -999;
  let bestThreshold = 0;
  let bestCombo: WeightCombo = GRID_COMBOS[0];

  for (const threshold of MTF_THRESHOLDS) {
    for (const combo of GRID_COMBOS) {
      const metrics = calcTop1Metrics(dailyCandidates, trainDays, combo, threshold, 1);
      if (metrics.avgReturn > bestAvg) {
        bestAvg = metrics.avgReturn;
        bestThreshold = threshold;
        bestCombo = combo;
      }
    }
  }

  console.log(`   訓練期冠軍: MTF≥${bestThreshold} + ${bestCombo.name}`);

  // Evaluate on training and test
  const trainMetrics = calcTop1Metrics(dailyCandidates, trainDays, bestCombo, bestThreshold, 1);
  const testMetrics  = calcTop1Metrics(dailyCandidates, testDays, bestCombo, bestThreshold, 1);

  // 效率比: 驗證期均報 / 訓練期均報
  // 特殊情況：訓練期虧損但驗證期盈利 → 驗證期更好
  const efficiencyRatio = trainMetrics.avgReturn > 0
    ? testMetrics.avgReturn / trainMetrics.avgReturn
    : (testMetrics.avgReturn > trainMetrics.avgReturn ? 2 : 0);

  // 過擬合判定：
  // 1. 訓練期正、驗證期不到一半 → 過擬合
  // 2. 訓練期正、驗證期虧損 → 過擬合
  // 3. 訓練期負、驗證期也負 → 策略本身不行（非過擬合問題）
  const isOverfit = trainMetrics.avgReturn > 0 && testMetrics.avgReturn < trainMetrics.avgReturn * 0.5;

  console.log(`   驗證期均報: ${testMetrics.avgReturn.toFixed(3)}%`);
  console.log(`   效率比: ${(efficiencyRatio * 100).toFixed(1)}%`);

  return {
    strategy: { threshold: bestThreshold, combo: bestCombo },
    trainMetrics,
    testMetrics,
    isOverfit,
    efficiencyRatio: +efficiencyRatio.toFixed(3),
  };
}
