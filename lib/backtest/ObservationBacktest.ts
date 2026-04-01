/**
 * ObservationBacktest.ts — 回測模式 A：選股後表現觀察型回測
 *
 * 目的：驗證選股 SOP + 排序因子的效果
 *   - 在指定日期範圍內，每天執行掃描
 *   - 用指定的排序因子對候選股排序
 *   - 追蹤排名第1/前3的股票在 d1/d2/d3/d5/d10/d20 的表現
 *   - 輸出可用於 Spearman IC 計算的資料集
 *
 * 與 ForwardAnalyzer 的差異：
 *   - ForwardAnalyzer：針對「已知的掃描結果」計算前瞻報酬
 *   - ObservationBacktest：整合「掃描 + 排序 + 前瞻報酬」完整流程
 *
 * 使用場景：
 *   - 驗證哪個排序因子（composite/surge/smartMoney/histWinRate）表現最佳
 *   - 比較台股 vs 陸股的最佳因子組合
 *   - 分析 Top-1 vs Top-3 的勝率差異
 */

import type { StockScanResult, MarketId } from '@/lib/scanner/types';

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * 單筆觀察紀錄：某天某檔股票的排名 + 後續表現
 */
export interface ObservationRecord {
  symbol:              string;
  name:                string;
  market:              MarketId;
  scanDate:            string;           // 掃描日期
  rank:                number;           // 排序名次（1=最高）
  rankingFactorUsed:   string;           // 用了哪個排序因子
  scanPrice:           number;           // 掃描日收盤價
  sixConditionsScore:  number;           // 0-6
  compositeScore?:     number;           // 複合評分
  surgeScore?:         number;           // 飆股潛力分
  smartMoneyScore?:    number;           // 智慧資金分
  histWinRate?:        number;           // 歷史勝率 %

  // 進場基準
  nextOpenPrice?:      number;           // 隔日開盤（null = 資料不足）

  // 以隔日開盤為基準的報酬率（與 BacktestEngine 進場一致）
  returnD1?:           number;           // 1 日後 %
  returnD2?:           number;
  returnD3?:           number;
  returnD5?:           number;           // 5 日後 %
  returnD10?:          number;           // 10 日後 %
  returnD20?:          number;           // 20 日後 %
  maxGain?:            number;           // 區間最大漲幅 % (vs nextOpen)
  maxDrawdown?:        number;           // 區間最大回撤 % (vs nextOpen, 負數)
}

/**
 * 單次觀察回測的摘要統計
 */
export interface ObservationSummary {
  rankingFactor:    string;
  market:           MarketId;
  dateRange:        { start: string; end: string };
  totalSignals:     number;           // 總訊號數
  top1WinRate?:     number;           // Top-1 勝率 %（以 d5 報酬 > 0 計算）
  top3WinRate?:     number;           // Top-3 勝率 %
  top1AvgReturn?:   number;           // Top-1 平均 d5 報酬 %
  top3AvgReturn?:   number;           // Top-3 平均 d5 報酬 %
  spearmanIC?:      number;           // 排名與 d5 報酬的 Spearman IC
  icIR?:            number;           // IC Information Ratio（IC / IC標準差）
  coverageRate?:    number;           // 有前瞻資料的覆蓋率 %
}

/**
 * 觀察回測完整結果
 */
export interface ObservationBacktestResult {
  records:  ObservationRecord[];
  summary:  ObservationSummary;
}

// ── 排序因子取值 ──────────────────────────────────────────────────────────────

type RankingFactor = 'composite' | 'surge' | 'smartMoney' | 'histWinRate' | 'sixConditions';

function getFactorValue(result: StockScanResult, factor: RankingFactor): number {
  switch (factor) {
    case 'composite':     return result.compositeScore  ?? 0;
    case 'surge':         return result.surgeScore       ?? 0;
    case 'smartMoney':    return result.smartMoneyScore  ?? 0;
    case 'histWinRate':   return result.histWinRate       ?? 0;
    case 'sixConditions': return result.sixConditionsScore;
  }
}

// ── 統計工具 ──────────────────────────────────────────────────────────────────

function spearmanRankCorrelation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 4) return null;

  function rankArray(arr: number[]): number[] {
    const sorted = [...arr].map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const ranks = new Array(n).fill(0);
    for (let i = 0; i < n; i++) ranks[sorted[i].i] = i + 1;
    return ranks;
  }

  const rankX = rankArray(xs);
  const rankY = rankArray(ys);
  const dSqSum = rankX.reduce((s, rx, i) => s + (rx - rankY[i]) ** 2, 0);
  return 1 - (6 * dSqSum) / (n * (n * n - 1));
}

// ── 前瞻報酬計算（不呼叫外部 API，使用已傳入的 forwardData）────────────────

export interface ForwardEntry {
  symbol:       string;
  nextOpen?:    number | null;
  returnD1?:    number | null;
  returnD2?:    number | null;
  returnD3?:    number | null;
  returnD5?:    number | null;
  returnD10?:   number | null;
  returnD20?:   number | null;
  maxGain?:     number;
  maxDrawdown?: number;
}

// ── 核心函數 ──────────────────────────────────────────────────────────────────

/**
 * 從掃描結果 + 前瞻資料，建立觀察紀錄
 *
 * @param scanResults  某一天的掃描結果（已含分數，未排序）
 * @param scanDate     掃描日期
 * @param factor       排序因子
 * @param forwardData  已取得的前瞻表現（symbol → ForwardEntry）
 */
export function buildObservationRecords(
  scanResults: StockScanResult[],
  scanDate:    string,
  factor:      RankingFactor,
  forwardData: Record<string, ForwardEntry>,
): ObservationRecord[] {
  // 按排序因子降序排列
  const sorted = [...scanResults].sort(
    (a, b) => getFactorValue(b, factor) - getFactorValue(a, factor)
  );

  return sorted.map((result, idx) => {
    const fwd = forwardData[result.symbol];

    return {
      symbol:             result.symbol,
      name:               result.name,
      market:             result.market,
      scanDate,
      rank:               idx + 1,
      rankingFactorUsed:  factor,
      scanPrice:          result.price,
      sixConditionsScore: result.sixConditionsScore,
      compositeScore:     result.compositeScore,
      surgeScore:         result.surgeScore,
      smartMoneyScore:    result.smartMoneyScore,
      histWinRate:        result.histWinRate,
      nextOpenPrice:      fwd?.nextOpen      ?? undefined,
      returnD1:           fwd?.returnD1      ?? undefined,
      returnD2:           fwd?.returnD2      ?? undefined,
      returnD3:           fwd?.returnD3      ?? undefined,
      returnD5:           fwd?.returnD5      ?? undefined,
      returnD10:          fwd?.returnD10     ?? undefined,
      returnD20:          fwd?.returnD20     ?? undefined,
      maxGain:            fwd?.maxGain       ?? undefined,
      maxDrawdown:        fwd?.maxDrawdown   ?? undefined,
    };
  });
}

/**
 * 從多天的觀察紀錄計算摘要統計
 */
export function computeObservationSummary(
  records:      ObservationRecord[],
  factor:       RankingFactor,
  market:       MarketId,
  dateRange:    { start: string; end: string },
): ObservationSummary {
  const withFwd = records.filter(r => r.returnD5 != null);
  const top1    = records.filter(r => r.rank === 1 && r.returnD5 != null);
  const top3    = records.filter(r => r.rank <= 3 && r.returnD5 != null);

  const avg = (arr: number[]) => arr.length === 0 ? undefined : +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2);
  const winRate = (arr: ObservationRecord[]) => {
    if (arr.length === 0) return undefined;
    return +((arr.filter(r => (r.returnD5 ?? 0) > 0).length / arr.length) * 100).toFixed(1);
  };

  const top1Returns = top1.map(r => r.returnD5!);
  const top3Returns = top3.map(r => r.returnD5!);

  // Spearman IC：排序因子值 vs d5 報酬
  let spearmanIC: number | undefined;
  let icIR: number | undefined;
  if (withFwd.length >= 4) {
    const factorVals = withFwd.map(r => getFactorValue(r as unknown as StockScanResult, factor));
    const d5Returns  = withFwd.map(r => r.returnD5!);
    spearmanIC = spearmanRankCorrelation(factorVals, d5Returns) ?? undefined;
    if (spearmanIC != null) {
      spearmanIC = +spearmanIC.toFixed(4);
      // IC IR：IC / std(IC)，這裡用單一 IC 近似（多日時應用滾動 IC 計算）
      const mean = spearmanIC;
      const variance = withFwd.reduce((s, r) => {
        const v = getFactorValue(r as unknown as StockScanResult, factor);
        return s + (v - mean) ** 2;
      }, 0) / withFwd.length;
      const std = Math.sqrt(variance);
      icIR = std > 0 ? +(mean / std).toFixed(3) : undefined;
    }
  }

  return {
    rankingFactor:  factor,
    market,
    dateRange,
    totalSignals:   records.length,
    top1WinRate:    winRate(top1),
    top3WinRate:    winRate(top3),
    top1AvgReturn:  avg(top1Returns),
    top3AvgReturn:  avg(top3Returns),
    spearmanIC,
    icIR,
    coverageRate: records.length > 0
      ? +(withFwd.length / records.length * 100).toFixed(1)
      : undefined,
  };
}

/**
 * 完整的觀察型回測流程（無 I/O，由呼叫方負責提供掃描結果和前瞻資料）
 *
 * 設計說明：此函數純粹做計算，不呼叫外部 API，
 * 方便在 API route 中分批並行處理。
 */
export function runObservationBacktest(
  allScanResults: Array<{ date: string; results: StockScanResult[] }>,
  allForwardData: Record<string, Record<string, ForwardEntry>>, // { date → { symbol → ForwardEntry } }
  factor:         RankingFactor,
  market:         MarketId,
): ObservationBacktestResult {
  const allRecords: ObservationRecord[] = [];

  for (const { date, results } of allScanResults) {
    if (results.length === 0) continue;
    const fwdForDate = allForwardData[date] ?? {};
    const dayRecords = buildObservationRecords(results, date, factor, fwdForDate);
    allRecords.push(...dayRecords);
  }

  const dates = allScanResults.map(s => s.date).sort();
  const summary = computeObservationSummary(
    allRecords,
    factor,
    market,
    { start: dates[0] ?? '', end: dates[dates.length - 1] ?? '' },
  );

  return { records: allRecords, summary };
}

// ── 多因子對比（Phase 6）────────────────────────────────────────────────────

export interface FactorComparisonRow {
  factor:         RankingFactor;
  top1WinRate?:   number;
  top3WinRate?:   number;
  top1AvgReturn?: number;
  top3AvgReturn?: number;
  spearmanIC?:    number;
  icIR?:          number;
  totalSignals:   number;
  coverageRate?:  number;
}

/**
 * 一次性對比所有排序因子的效果
 * 在同一份掃描資料 + 前瞻資料上，分別用 5 種因子排序，輸出對比表格
 */
export function runMultiFactorComparison(
  allScanResults: Array<{ date: string; results: StockScanResult[] }>,
  allForwardData: Record<string, Record<string, ForwardEntry>>,
  market:         MarketId,
): FactorComparisonRow[] {
  const factors: RankingFactor[] = ['composite', 'surge', 'smartMoney', 'histWinRate', 'sixConditions'];
  const dates = allScanResults.map(s => s.date).sort();
  const dateRange = { start: dates[0] ?? '', end: dates[dates.length - 1] ?? '' };

  return factors.map(factor => {
    const allRecords: ObservationRecord[] = [];
    for (const { date, results } of allScanResults) {
      if (results.length === 0) continue;
      const fwdForDate = allForwardData[date] ?? {};
      allRecords.push(...buildObservationRecords(results, date, factor, fwdForDate));
    }
    const summary = computeObservationSummary(allRecords, factor, market, dateRange);
    return {
      factor,
      top1WinRate:   summary.top1WinRate,
      top3WinRate:   summary.top3WinRate,
      top1AvgReturn: summary.top1AvgReturn,
      top3AvgReturn: summary.top3AvgReturn,
      spearmanIC:    summary.spearmanIC,
      icIR:          summary.icIR,
      totalSignals:  summary.totalSignals,
      coverageRate:  summary.coverageRate,
    };
  });
}
