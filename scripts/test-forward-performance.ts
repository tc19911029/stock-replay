/**
 * Test forward performance of Top 3 picks across 10 historical scan dates.
 * Usage: npx tsx scripts/test-forward-performance.ts
 */
import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { resolveThresholds } from '../lib/strategy/resolveThresholds';
import { analyzeForwardBatch } from '../lib/backtest/ForwardAnalyzer';
import { calcComposite } from '../features/scan/utils';
import type { StockScanResult } from '../lib/scanner/types';

// 10 個歷史掃描日期（2025年底到2026年初，間隔約2週）
const SCAN_DATES = [
  '2025-10-15',
  '2025-11-03',
  '2025-11-17',
  '2025-12-01',
  '2025-12-15',
  '2026-01-06',
  '2026-01-20',
  '2026-02-10',
  '2026-02-24',
  '2026-03-10',
];

function selectTop3(results: StockScanResult[]): StockScanResult[] {
  const sorted = [...results]
    .filter(r => r.surgeScore != null && r.surgeScore >= 30)
    .map(r => ({ ...r, _composite: calcComposite(r) }))
    .sort((a, b) => (b as any)._composite - (a as any)._composite);

  // 板塊分散：同板塊最多 2 支
  const top3: StockScanResult[] = [];
  const sectorCount: Record<string, number> = {};
  for (const s of sorted) {
    const sector = s.industry || s.symbol.slice(0, 2);
    if ((sectorCount[sector] || 0) >= 2) continue;
    top3.push(s);
    sectorCount[sector] = (sectorCount[sector] || 0) + 1;
    if (top3.length >= 3) break;
  }
  return top3;
}

interface DateResult {
  date: string;
  stockCount: number;
  top3: Array<{
    symbol: string;
    name: string;
    composite: number;
    winRate?: number;
    d1?: number | null;
    d3?: number | null;
    d5?: number | null;
    d10?: number | null;
    d20?: number | null;
    maxGain?: number;
    maxLoss?: number;
  }>;
  nullCount: number;
}

async function runOne(scanDate: string): Promise<DateResult> {
  const thresholds = resolveThresholds({ strategyId: 'ZHU_V1' });
  const scanner = new TaiwanScanner();

  console.log(`\n🔍 掃描 ${scanDate} ...`);
  const stockList = await scanner.getStockList();
  const { results } = await scanner.scanListAtDate(stockList, scanDate, thresholds);
  console.log(`   找到 ${results.length} 支`);

  const top3 = selectTop3(results);
  if (top3.length === 0) {
    console.log(`   ⚠️ 無符合條件的股票`);
    return { date: scanDate, stockCount: results.length, top3: [], nullCount: 0 };
  }

  console.log(`   Top 3: ${top3.map(s => `${s.name}(${s.compositeScore})`).join(', ')}`);

  // 前瞻績效
  const stocks = top3.map(s => ({ symbol: s.symbol, name: s.name, scanPrice: s.price }));
  const { results: fwd, nullCount } = await analyzeForwardBatch(stocks, scanDate);
  const fwdMap = new Map(fwd.map(f => [f.symbol, f]));

  const top3Results = top3.map(s => {
    const f = fwdMap.get(s.symbol);
    return {
      symbol: s.symbol,
      name: s.name,
      composite: s.compositeScore ?? 0,
      winRate: s.histWinRate,
      d1: f?.d1ReturnFromOpen ?? f?.d1Return,
      d3: f?.d3Return,
      d5: f?.d5ReturnFromOpen ?? f?.d5Return,
      d10: f?.d10ReturnFromOpen ?? f?.d10Return,
      d20: f?.d20ReturnFromOpen ?? f?.d20Return,
      maxGain: f?.maxGain,
      maxLoss: f?.maxLoss,
    };
  });

  return { date: scanDate, stockCount: results.length, top3: top3Results, nullCount };
}

async function main() {
  console.log('='.repeat(80));
  console.log('📊 Top 3 前瞻績效測試（10 個歷史掃描日期）');
  console.log('='.repeat(80));

  const allResults: DateResult[] = [];

  for (const date of SCAN_DATES) {
    try {
      const result = await runOne(date);
      allResults.push(result);

      for (const s of result.top3) {
        const d5 = s.d5 != null ? (s.d5 > 0 ? `+${s.d5.toFixed(1)}%` : `${s.d5.toFixed(1)}%`) : '—';
        const d10 = s.d10 != null ? (s.d10 > 0 ? `+${s.d10.toFixed(1)}%` : `${s.d10.toFixed(1)}%`) : '—';
        console.log(`   ${s.name.padEnd(6)} | 評分:${s.composite} | 勝率:${s.winRate ?? '—'}% | D5:${d5} | D10:${d10} | 最大漲:${s.maxGain?.toFixed(1) ?? '—'}% | 最大跌:${s.maxLoss?.toFixed(1) ?? '—'}%`);
      }
    } catch (err) {
      console.error(`   ❌ ${date} 失敗:`, (err as Error).message);
      allResults.push({ date, stockCount: 0, top3: [], nullCount: 0 });
    }
  }

  // ── 彙總統計 ──────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('📈 彙總統計');
  console.log('='.repeat(80));

  const allPicks = allResults.flatMap(r => r.top3);
  const totalPicks = allPicks.length;

  for (const horizon of ['d1', 'd3', 'd5', 'd10', 'd20'] as const) {
    const returns = allPicks
      .map(p => p[horizon])
      .filter((r): r is number => r != null);
    if (returns.length === 0) continue;

    const wins = returns.filter(r => r > 0).length;
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    const median = [...returns].sort((a, b) => a - b)[Math.floor(returns.length / 2)];

    console.log(`${horizon.toUpperCase().padEnd(4)} | 樣本:${returns.length} | 勝率:${(wins / returns.length * 100).toFixed(0)}% | 平均:${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% | 中位數:${median >= 0 ? '+' : ''}${median.toFixed(2)}%`);
  }

  // maxGain / maxLoss
  const gains = allPicks.map(p => p.maxGain).filter((r): r is number => r != null);
  const losses = allPicks.map(p => p.maxLoss).filter((r): r is number => r != null);
  if (gains.length > 0) {
    console.log(`\n平均最大漲幅: +${(gains.reduce((a, b) => a + b, 0) / gains.length).toFixed(2)}%`);
    console.log(`平均最大跌幅: ${(losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(2)}%`);
  }

  console.log(`\n總掃描次數: ${allResults.length}`);
  console.log(`總選股數: ${totalPicks}`);
  console.log(`無前瞻數據: ${allResults.reduce((a, r) => a + r.nullCount, 0)} 支`);
}

main().catch(console.error);
