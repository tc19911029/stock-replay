/**
 * A/B Test: 比較兩種排序方法的回測績效
 *
 * 方法A（高勝率優先）：highWinRateScore > resonanceScore > changePercent（逐層比較）
 * 方法B（加總排序）：(highWinRateScore + resonanceScore) 加總 > changePercent
 *
 * Usage: npx tsx scripts/compare-ranking.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadLocalCandles } from '../lib/datasource/LocalCandleStore';
import {
  runSingleBacktest,
  calcBacktestStats,
  scanResultToSignal,
  PURE_ZHU_STRATEGY,
} from '../lib/backtest/BacktestEngine';
import type { BacktestTrade } from '../lib/backtest/BacktestEngine';
import type { StockScanResult, ForwardCandle } from '../lib/scanner/types';

// ── 兩種排序函數 ──────────────────────────────────────────────────────────

function sortMethodA(results: StockScanResult[]): StockScanResult[] {
  return [...results].sort((a, b) =>
    (b.highWinRateScore ?? 0) - (a.highWinRateScore ?? 0) ||
    (b.resonanceScore ?? 0) - (a.resonanceScore ?? 0) ||
    b.changePercent - a.changePercent
  );
}

function sortMethodB(results: StockScanResult[]): StockScanResult[] {
  return [...results].sort((a, b) =>
    (b.resonanceScore ?? 0) + (b.highWinRateScore ?? 0) -
    (a.resonanceScore ?? 0) - (a.highWinRateScore ?? 0) ||
    b.changePercent - a.changePercent
  );
}

// ── Spearman rank correlation ─────────────────────────────────────────────

function spearmanCorrelation(ranks: number[], values: number[]): number {
  const n = ranks.length;
  if (n < 3) return 0;

  // Rank the values (higher return = lower rank number = better)
  const valueRanks = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v)
    .map((item, rank) => ({ ...item, rank: rank + 1 }))
    .sort((a, b) => a.i - b.i)
    .map(item => item.rank);

  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = ranks[i] - valueRanks[i];
    sumD2 += d * d;
  }

  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

// ── 取前瞻 K 線 ──────────────────────────────────────────────────────────

const FORWARD_WINDOW_DAYS = 45;

async function getForwardCandlesMap(
  results: StockScanResult[],
  scanDate: string,
): Promise<Record<string, ForwardCandle[]>> {
  const startMs = Date.parse(scanDate) + 86400_000;
  const endMs = startMs + FORWARD_WINDOW_DAYS * 86400_000;
  const startStr = new Date(startMs).toISOString().split('T')[0];
  const endStr = new Date(endMs).toISOString().split('T')[0];

  // 防止取到未來數據
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 3600_000);
  const todayStr = utc8.toISOString().split('T')[0];
  const safeEndStr = endStr > todayStr ? todayStr : endStr;

  const map: Record<string, ForwardCandle[]> = {};

  for (const r of results) {
    const market = /\.(SS|SZ)$/i.test(r.symbol) ? 'CN' as const : 'TW' as const;
    const candles = await loadLocalCandles(r.symbol, market);
    if (!candles) continue;

    const forward = candles
      .filter(c => c.date >= startStr && c.date <= safeEndStr)
      .map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));

    if (forward.length > 0) {
      map[r.symbol] = forward;
    }
  }

  return map;
}

// ── 主邏輯 ────────────────────────────────────────────────────────────────

interface DayResult {
  date: string;
  totalStocks: number;
  tradesA: BacktestTrade[];
  tradesB: BacktestTrade[];
  top3OverlapCount: number;
  spearmanA: number;
  spearmanB: number;
}

async function processOneDay(filePath: string): Promise<DayResult | null> {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const results: StockScanResult[] = data.results;
  const date: string = data.date;

  if (results.length < 2) return null;

  // 取前瞻 K 線
  const forwardMap = await getForwardCandlesMap(results, date);

  // 兩種排序
  const sortedA = sortMethodA(results);
  const sortedB = sortMethodB(results);

  // 全部跑回測（用每支的實際報酬）
  const tradeMap = new Map<string, BacktestTrade>();
  for (const r of results) {
    const candles = forwardMap[r.symbol];
    if (!candles || candles.length === 0) continue;
    const signal = scanResultToSignal(r);
    const trade = runSingleBacktest(signal, candles, PURE_ZHU_STRATEGY);
    if (trade) tradeMap.set(r.symbol, trade);
  }

  // 計算 Spearman correlation
  const calcSpearman = (sorted: StockScanResult[]): number => {
    const ranks: number[] = [];
    const returns: number[] = [];
    sorted.forEach((r, idx) => {
      const trade = tradeMap.get(r.symbol);
      if (trade) {
        ranks.push(idx + 1);
        returns.push(trade.netReturn);
      }
    });
    return spearmanCorrelation(ranks, returns);
  };

  const spearmanA = calcSpearman(sortedA);
  const spearmanB = calcSpearman(sortedB);

  // Top 3 重疊
  const top3A = new Set(sortedA.slice(0, 3).map(r => r.symbol));
  const top3B = new Set(sortedB.slice(0, 3).map(r => r.symbol));
  const top3OverlapCount = [...top3A].filter(s => top3B.has(s)).length;

  // 按排序取 trades
  const getTradesInOrder = (sorted: StockScanResult[]): BacktestTrade[] => {
    return sorted
      .map(r => tradeMap.get(r.symbol))
      .filter((t): t is BacktestTrade => t != null);
  };

  return {
    date,
    totalStocks: results.length,
    tradesA: getTradesInOrder(sortedA),
    tradesB: getTradesInOrder(sortedB),
    top3OverlapCount,
    spearmanA,
    spearmanB,
  };
}

function printStats(label: string, trades: BacktestTrade[]) {
  const stats = calcBacktestStats(trades, 0);
  if (!stats) {
    console.log(`  ${label}: 無交易`);
    return;
  }
  const avg = stats.avgNetReturn >= 0 ? `+${stats.avgNetReturn.toFixed(2)}` : stats.avgNetReturn.toFixed(2);
  const med = stats.medianReturn >= 0 ? `+${stats.medianReturn.toFixed(2)}` : stats.medianReturn.toFixed(2);
  const sharpe = stats.sharpeRatio != null ? stats.sharpeRatio.toFixed(2) : '—';
  const pf = stats.profitFactor != null ? stats.profitFactor.toFixed(2) : '—';
  console.log(`  ${label}: 交易${String(stats.count).padStart(3)}筆 | 勝率${(stats.winRate * 100).toFixed(0).padStart(3)}% | 均報${avg.padStart(7)}% | 中位${med.padStart(7)}% | Sharpe ${sharpe.padStart(5)} | PF ${pf.padStart(5)}`);
}

async function main() {
  const dataDir = path.resolve(__dirname, '../data');
  const files = fs.readdirSync(dataDir)
    .filter(f => f.match(/^scan-TW-long-daily-/))
    .sort();

  console.log('='.repeat(72));
  console.log('  排序方法 A/B 回測比較');
  console.log('  A = 高勝率優先（逐層）  B = 加總排序');
  console.log('='.repeat(72));
  console.log(`\n掃描檔案: ${files.length} 天\n`);

  const allResults: DayResult[] = [];

  for (const file of files) {
    const filePath = path.join(dataDir, file);
    const date = file.replace('scan-TW-long-daily-', '').replace('.json', '');
    process.stdout.write(`  ${date} ...`);

    try {
      const result = await processOneDay(filePath);
      if (result) {
        allResults.push(result);
        const overlap = result.top3OverlapCount;
        process.stdout.write(` ${result.totalStocks}支 | Top3重疊${overlap}/3 | Spearman A:${result.spearmanA.toFixed(2)} B:${result.spearmanB.toFixed(2)}\n`);
      } else {
        process.stdout.write(` 跳過（<2支）\n`);
      }
    } catch (err) {
      process.stdout.write(` 失敗: ${(err as Error).message}\n`);
    }
  }

  // ── 彙總 ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(72));
  console.log('  彙總結果');
  console.log('='.repeat(72));

  // 收集全部 trades
  const allTradesA: BacktestTrade[] = [];
  const allTradesB: BacktestTrade[] = [];
  const top1TradesA: BacktestTrade[] = [];
  const top1TradesB: BacktestTrade[] = [];
  const top3TradesA: BacktestTrade[] = [];
  const top3TradesB: BacktestTrade[] = [];
  const top5TradesA: BacktestTrade[] = [];
  const top5TradesB: BacktestTrade[] = [];
  let totalOverlap = 0;
  let totalTop3Days = 0;
  const spearmanAs: number[] = [];
  const spearmanBs: number[] = [];

  for (const r of allResults) {
    allTradesA.push(...r.tradesA);
    allTradesB.push(...r.tradesB);
    top1TradesA.push(...r.tradesA.slice(0, 1));
    top1TradesB.push(...r.tradesB.slice(0, 1));
    top3TradesA.push(...r.tradesA.slice(0, 3));
    top3TradesB.push(...r.tradesB.slice(0, 3));
    top5TradesA.push(...r.tradesA.slice(0, 5));
    top5TradesB.push(...r.tradesB.slice(0, 5));
    totalOverlap += r.top3OverlapCount;
    totalTop3Days++;
    if (r.spearmanA !== 0) spearmanAs.push(r.spearmanA);
    if (r.spearmanB !== 0) spearmanBs.push(r.spearmanB);
  }

  console.log(`\n有效天數: ${allResults.length} | 總交易: ${allTradesA.length}筆\n`);

  console.log('【全部股票】（兩種排序結果相同）');
  printStats('全部', allTradesA);

  console.log('\n【Top 1】');
  printStats('方法A', top1TradesA);
  printStats('方法B', top1TradesB);

  console.log('\n【Top 3】');
  printStats('方法A', top3TradesA);
  printStats('方法B', top3TradesB);

  console.log('\n【Top 5】');
  printStats('方法A', top5TradesA);
  printStats('方法B', top5TradesB);

  // Spearman 平均
  const avgSpearmanA = spearmanAs.length > 0
    ? spearmanAs.reduce((a, b) => a + b, 0) / spearmanAs.length
    : 0;
  const avgSpearmanB = spearmanBs.length > 0
    ? spearmanBs.reduce((a, b) => a + b, 0) / spearmanBs.length
    : 0;

  console.log('\n【排名-報酬相關性 Spearman（越負=排名越準）】');
  console.log(`  方法A: ${avgSpearmanA.toFixed(3)}（${spearmanAs.length}天平均）`);
  console.log(`  方法B: ${avgSpearmanB.toFixed(3)}（${spearmanBs.length}天平均）`);

  console.log(`\n【Top3 重疊率】${totalTop3Days > 0 ? ((totalOverlap / (totalTop3Days * 3)) * 100).toFixed(0) : 0}%（${totalOverlap}/${totalTop3Days * 3}）`);

  // 結論
  console.log('\n' + '-'.repeat(72));
  const aWins = (top3TradesA.filter(t => t.netReturn > 0).length / top3TradesA.length) || 0;
  const bWins = (top3TradesB.filter(t => t.netReturn > 0).length / top3TradesB.length) || 0;
  const aAvg = top3TradesA.length > 0 ? top3TradesA.reduce((s, t) => s + t.netReturn, 0) / top3TradesA.length : 0;
  const bAvg = top3TradesB.length > 0 ? top3TradesB.reduce((s, t) => s + t.netReturn, 0) / top3TradesB.length : 0;

  if (aAvg > bAvg) {
    console.log(`  結論: 方法A（高勝率優先）Top3 平均報酬 ${aAvg.toFixed(2)}% > 方法B ${bAvg.toFixed(2)}%`);
  } else if (bAvg > aAvg) {
    console.log(`  結論: 方法B（加總排序）Top3 平均報酬 ${bAvg.toFixed(2)}% > 方法A ${aAvg.toFixed(2)}%`);
  } else {
    console.log(`  結論: 兩種方法 Top3 平均報酬相同 ${aAvg.toFixed(2)}%`);
  }
  console.log('-'.repeat(72));
}

main().catch(console.error);
