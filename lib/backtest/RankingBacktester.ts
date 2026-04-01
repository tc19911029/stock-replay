/**
 * RankingBacktester.ts — 排名維度回測
 *
 * 回答：「策略選出 10 檔股票，用哪個分數挑最準？」
 *
 * 方法：
 * 1. 收集 N 天的歷史掃描結果（每天 5-20 檔候選股群組）
 * 2. 對每天的群組，用不同維度排名
 * 3. 計算 Top1 命中率、Top3 捕獲率、Spearman IC
 * 4. 輸出：哪個排名維度最準
 */

import type { StockScanResult, ForwardCandle } from '@/lib/scanner/types';
import {
  runSOPBacktest,
  scanResultToSignal,
  DEFAULT_ZHU_EXIT,
  ZHU_PROFIT_FORMULA_STRATEGY,
  type ZhuExitParams,
  type BacktestStrategyParams,
} from './BacktestEngine';

// ── 排名維度定義 ────────────────────────────────────────────────────────────────

export interface RankingDimension {
  id: string;
  name: string;
  /** 從 StockScanResult 中提取排名分數，越高越好 */
  extract: (r: StockScanResult) => number;
}

/** 系統內建的可測試排名維度 */
export const RANKING_DIMENSIONS: RankingDimension[] = [
  {
    id: 'sixConditions',
    name: '六大條件分數',
    extract: (r) => r.sixConditionsScore,
  },
  {
    id: 'surgeScore',
    name: '飆股潛力分',
    extract: (r) => r.surgeScore ?? 0,
  },
  {
    id: 'compositeScore',
    name: '綜合分',
    extract: (r) => r.compositeScore ?? 0,
  },
  {
    id: 'smartMoneyScore',
    name: '主力買賣力道',
    extract: (r) => r.smartMoneyScore ?? 0,
  },
  {
    id: 'histWinRate',
    name: '歷史勝率',
    extract: (r) => r.histWinRate ?? 0,
  },
  {
    id: 'breakthroughScore',
    name: '突破品質',
    extract: (r) => r.breakthroughScore ?? 0,
  },
  {
    id: 'highWinRateScore',
    name: '高勝率進場位置',
    extract: (r) => r.highWinRateScore ?? 0,
  },
  {
    id: 'chipScore',
    name: '籌碼面',
    extract: (r) => r.chipScore ?? 0,
  },
];

// ── 結果類型 ────────────────────────────────────────────────────────────────────

export interface DimensionAccuracy {
  dimensionId: string;
  dimensionName: string;
  /** Top1 的股票實際報酬 > 群組平均的比例 */
  top1HitRate: number;
  /** 實際最佳股在排名前 3 內的比例 */
  top3CaptureRate: number;
  /** 排名 vs 實際報酬的 Spearman 秩相關 */
  spearmanIC: number;
  /** 有效群組數（至少 3 檔候選股的天數） */
  validGroupCount: number;
}

export interface RankingBacktestResult {
  dimensions: DimensionAccuracy[];
  /** 隨機選股的對照組 Top1 命中率 */
  randomTop1HitRate: number;
  /** 群組總天數 */
  totalGroups: number;
  /** 最佳維度 ID */
  bestDimensionId: string;
}

// ── 核心邏輯 ────────────────────────────────────────────────────────────────────

interface DayGroup {
  date: string;
  results: StockScanResult[];
  /** 每檔股票的實際回測報酬 */
  returns: Map<string, number>;
}

/**
 * 執行排名維度回測
 *
 * @param sessions   按日分組的掃描結果 [{ date, results }]
 * @param forwardCandlesMap 每檔股票的前向K線
 * @param dimensions 要測試的排名維度
 * @param strategy   回測策略參數
 * @param zhuExit    朱老師出場參數
 * @param minGroupSize 每天至少需要幾檔候選股才計入統計（預設 3）
 */
export function runRankingBacktest(
  sessions:           Array<{ date: string; results: StockScanResult[] }>,
  forwardCandlesMap:  Record<string, ForwardCandle[]>,
  dimensions:         RankingDimension[] = RANKING_DIMENSIONS,
  strategy:           BacktestStrategyParams = ZHU_PROFIT_FORMULA_STRATEGY,
  zhuExit:            ZhuExitParams = DEFAULT_ZHU_EXIT,
  minGroupSize = 3,
): RankingBacktestResult {
  // ── 計算每天每檔股票的實際報酬 ──
  const dayGroups: DayGroup[] = [];

  for (const session of sessions) {
    if (session.results.length < minGroupSize) continue;

    const returns = new Map<string, number>();
    for (const result of session.results) {
      const candles = forwardCandlesMap[result.symbol] ?? [];
      if (candles.length === 0) continue;
      const signal = scanResultToSignal(result);
      const trade = runSOPBacktest(signal, candles, strategy, zhuExit);
      if (trade) {
        returns.set(result.symbol, trade.netReturn);
      }
    }

    // 至少要有 minGroupSize 檔有效報酬
    if (returns.size >= minGroupSize) {
      dayGroups.push({
        date: session.date,
        results: session.results.filter((r) => returns.has(r.symbol)),
        returns,
      });
    }
  }

  if (dayGroups.length === 0) {
    return {
      dimensions: [],
      randomTop1HitRate: 0,
      totalGroups: 0,
      bestDimensionId: '',
    };
  }

  // ── 隨機選股的 Top1 命中率（對照組）──
  // 隨機選 1 檔 > 群組平均的機率 ≈ 50%（對稱分佈下）
  // 但實際計算更精確
  let randomHits = 0;
  let randomTotal = 0;
  for (const group of dayGroups) {
    const rets = Array.from(group.returns.values());
    const avg = rets.reduce((s, v) => s + v, 0) / rets.length;
    const aboveAvg = rets.filter((r) => r > avg).length;
    randomHits += aboveAvg;
    randomTotal += rets.length;
  }
  const randomTop1HitRate = randomTotal > 0 ? +(randomHits / randomTotal).toFixed(4) : 0;

  // ── 對每個維度計算排名準確度 ──
  const dimensionResults: DimensionAccuracy[] = dimensions.map((dim) => {
    let top1Hits = 0;
    let top3Captures = 0;
    let validGroups = 0;
    const allRankCorrelations: number[] = [];

    for (const group of dayGroups) {
      const n = group.results.length;
      if (n < minGroupSize) continue;
      validGroups++;

      // 用此維度排名
      const ranked = [...group.results].sort(
        (a, b) => dim.extract(b) - dim.extract(a),
      );

      // 實際報酬
      const rets = group.results.map((r) => group.returns.get(r.symbol) ?? 0);
      const avgReturn = rets.reduce((s, v) => s + v, 0) / rets.length;

      // 找到實際最佳股
      let bestSymbol = '';
      let bestReturn = -Infinity;
      for (const [sym, ret] of group.returns) {
        if (ret > bestReturn) {
          bestReturn = ret;
          bestSymbol = sym;
        }
      }

      // Top1 命中率：排名第 1 的報酬 > 群組平均
      const top1Symbol = ranked[0]?.symbol;
      const top1Return = group.returns.get(top1Symbol) ?? 0;
      if (top1Return > avgReturn) top1Hits++;

      // Top3 捕獲率：實際最佳股在排名前 3 內
      const top3Symbols = ranked.slice(0, 3).map((r) => r.symbol);
      if (top3Symbols.includes(bestSymbol)) top3Captures++;

      // Spearman 秩相關
      const rankScores = ranked.map((r) => dim.extract(r));
      const rankReturns = ranked.map((r) => group.returns.get(r.symbol) ?? 0);
      const ic = spearmanRank(rankScores, rankReturns);
      if (!isNaN(ic)) allRankCorrelations.push(ic);
    }

    const avgIC = allRankCorrelations.length > 0
      ? allRankCorrelations.reduce((s, v) => s + v, 0) / allRankCorrelations.length
      : 0;

    return {
      dimensionId: dim.id,
      dimensionName: dim.name,
      top1HitRate: validGroups > 0 ? +(top1Hits / validGroups).toFixed(4) : 0,
      top3CaptureRate: validGroups > 0 ? +(top3Captures / validGroups).toFixed(4) : 0,
      spearmanIC: +avgIC.toFixed(4),
      validGroupCount: validGroups,
    };
  });

  // 找最佳維度（按 Spearman IC 排序）
  const sorted = [...dimensionResults].sort((a, b) => b.spearmanIC - a.spearmanIC);
  const bestDimensionId = sorted[0]?.dimensionId ?? '';

  return {
    dimensions: dimensionResults,
    randomTop1HitRate,
    totalGroups: dayGroups.length,
    bestDimensionId,
  };
}

// ── Spearman Rank Correlation ──────────────────────────────────────────────────

function spearmanRank(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;

  const rankX = toRanks(x);
  const rankY = toRanks(y);

  let sumXY = 0, sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += rankX[i];
    sumY += rankY[i];
    sumXY += rankX[i] * rankY[i];
    sumX2 += rankX[i] ** 2;
    sumY2 += rankY[i] ** 2;
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX ** 2) * (n * sumY2 - sumY ** 2),
  );

  if (denominator === 0) return 0;
  return numerator / denominator;
}

function toRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
    const avgRank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j;
  }
  return ranks;
}
