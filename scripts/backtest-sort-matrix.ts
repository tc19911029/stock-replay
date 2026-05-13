/**
 * 排序因子矩陣回測（2026-04-20 新建）
 *
 * 目的：6 策略 × 12 排序因子 × 3 期間 × 2 市場 下，每日挑 #1 觀察未來 5 日收盤報酬。
 *
 * 策略集（使用者 2026-04-20 重命名）：
 *   A      六條件 + 戒律 + 淘汰法
 *   A_MTF  A + 多時間軸過濾 (mtfScore ≥ 3)
 *   B      盤整突破 + 回後買上漲（純型態 + 淘汰法）
 *   C      V 形反轉（純型態 + 淘汰法）
 *   D      缺口（純型態 + 淘汰法，原 'E' 型態）
 *   E      一字底（純型態 + 淘汰法，原 'F' 型態）
 *
 * 期間（anchor = 2026-04-20）：
 *   P1  2024-04-22 ~ 2026-04-20  過去兩年
 *   P2  2025-04-21 ~ 2026-04-20  過去一年
 *   P3  2026-01-02 ~ 2026-04-20  YTD
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-sort-matrix.ts
 *   MARKET=TW PERIOD=P3 STRATEGY=A SORT=漲幅 NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-sort-matrix.ts
 *   MARKET=BOTH PERIOD=ALL STRATEGY=ALL SORT=ALL ...
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { evaluateMultiTimeframe } from '@/lib/analysis/multiTimeframeFilter';
import { evaluateHighWinRateEntry } from '@/lib/analysis/highWinRateEntry';
import { checkLongProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { detectBreakoutEntry } from '@/lib/analysis/breakoutEntry';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import type { CandleWithIndicators } from '@/types';
import { BASE_THRESHOLDS, ZHU_PURE_BOOK } from '@/lib/strategy/StrategyConfig';
import { ALL_SORT_FACTORS, SORT_DEFS, buildFeatures, type CandidateFeatures, type SortFactorName } from './_backtest-sort-defs';

// ══════════════════════════════════════════════════════════════
// 設定
// ══════════════════════════════════════════════════════════════

type Market = 'TW' | 'CN';
type StrategyCode = 'A' | 'A_MTF' | 'B' | 'C' | 'D' | 'E';

const PERIODS = {
  P1: { start: '2024-04-22', end: '2026-04-20', label: '兩年' },
  P2: { start: '2025-04-21', end: '2026-04-20', label: '一年' },
  P3: { start: '2026-01-02', end: '2026-04-20', label: 'YTD' },
} as const;

const ALL_STRATEGIES: StrategyCode[] = ['A', 'A_MTF', 'B', 'C', 'D', 'E'];

const ENV = {
  MARKET: (process.env.MARKET ?? 'BOTH') as 'TW' | 'CN' | 'BOTH',
  PERIOD: (process.env.PERIOD ?? 'ALL') as 'P1' | 'P2' | 'P3' | 'ALL',
  STRATEGY: (process.env.STRATEGY ?? 'ALL') as StrategyCode | 'ALL',
  SORT: (process.env.SORT ?? 'ALL') as SortFactorName | 'ALL',
  TOP_N: Number(process.env.TOP_N ?? 0),  // 20 日均成交額 topN，0 = 不篩
};

const SLIPPAGE_PCT = 0.001;
const MTF_CFG = { ...BASE_THRESHOLDS, multiTimeframeFilter: true };

// ══════════════════════════════════════════════════════════════
// 型別
// ══════════════════════════════════════════════════════════════

interface StockData {
  name: string;
  candles: CandleWithIndicators[];
}

interface TradeRecord {
  market: Market;
  period: 'P1' | 'P2' | 'P3';
  strategy: StrategyCode;
  sortFactor: SortFactorName;
  date: string;
  symbol: string;
  name: string;
  entryPrice: number;
  d1: number; d2: number; d3: number; d4: number; d5: number;  // % return vs entry
  d5Abs: number;  // d5 close price
}

// ══════════════════════════════════════════════════════════════
// 資料載入
// ══════════════════════════════════════════════════════════════

function loadStocks(market: Market): Map<string, StockData> {
  const stocks = new Map<string, StockData>();
  if (market === 'TW') {
    const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
    if (!fs.existsSync(dir)) { console.error('TW candles 目錄不存在：' + dir); return stocks; }
    process.stdout.write('  讀取 TW K 線...');
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        const c: CandleWithIndicators[] = Array.isArray(raw) ? raw : raw.candles ?? raw;
        if (!c || c.length < 60) continue;
        stocks.set(f.replace('.json', ''), {
          name: (raw as { name?: string }).name ?? f.replace('.json', ''),
          candles: computeIndicators(c),
        });
      } catch { /* skip */ }
    }
    console.log(` ${stocks.size} 支`);
    return stocks;
  }

  // CN
  const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');
  if (fs.existsSync(cacheFile)) {
    process.stdout.write('  讀取 CN bulk cache...');
    try {
      const bulk = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as Record<string, { name?: string; candles?: CandleWithIndicators[] }>;
      for (const [sym, data] of Object.entries(bulk)) {
        const c = Array.isArray(data) ? data : data.candles ?? [];
        if (!c || c.length < 60) continue;
        stocks.set(sym, {
          name: (data as { name?: string }).name ?? sym,
          candles: computeIndicators(c),
        });
      }
      console.log(` ${stocks.size} 支`);
    } catch (e) {
      console.log(` 失敗：${(e as Error).message}`);
    }
  }
  // per-symbol 補充
  const dir = path.join(process.cwd(), 'data', 'candles', 'CN');
  if (fs.existsSync(dir)) {
    let u = 0;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        const c: CandleWithIndicators[] = Array.isArray(raw) ? raw : raw.candles ?? raw;
        if (!c || c.length < 60) continue;
        const sym = f.replace('.json', '');
        const existing = stocks.get(sym);
        if (!existing || c.length > existing.candles.length) {
          stocks.set(sym, {
            name: (raw as { name?: string }).name ?? existing?.name ?? sym,
            candles: computeIndicators(c),
          });
          u++;
        }
      } catch { /* skip */ }
    }
    if (u > 0) console.log(`  更新 CN per-symbol ${u} 支，共 ${stocks.size} 支`);
  }
  return stocks;
}

// ══════════════════════════════════════════════════════════════
// 策略判定（回傳通過該策略的 symbol → features）
// ══════════════════════════════════════════════════════════════

function buildCandidate(
  strategy: StrategyCode,
  symbol: string,
  name: string,
  candles: CandleWithIndicators[],
  idx: number,
): CandidateFeatures | null {
  if (idx < 60 || idx + 5 >= candles.length) return null;

  let sixScore = 0;
  let deviation = 0;
  let mtfScore = 0;
  let highWinRateScore = 0;

  // 策略 A / A_MTF：跑六條件 + 戒律 + 淘汰法
  if (strategy === 'A' || strategy === 'A_MTF') {
    const six = evaluateSixConditions(candles, idx, ZHU_PURE_BOOK.thresholds);
    const minScore = ZHU_PURE_BOOK.thresholds.minScore ?? 5;
    if (!six.isCoreReady || six.totalScore < minScore) return null;
    if (checkLongProhibitions(candles, idx).prohibited) return null;
    if (evaluateElimination(candles, idx).eliminated) return null;
    sixScore = six.totalScore;
    deviation = six.position.deviation ?? 0;

    if (strategy === 'A_MTF') {
      // 2026-05-07：MTF 過濾改用 weeklyPass（鐵律 #10 對齊 applyPanelFilter）
      let mtfWeeklyPass = false;
      try {
        const mtfRes = evaluateMultiTimeframe(candles.slice(0, idx + 1), MTF_CFG);
        mtfScore = mtfRes.totalScore;
        mtfWeeklyPass = mtfRes.weeklyPass === true;
      } catch { mtfScore = 0; }
      if (!mtfWeeklyPass) return null;
    }
  } else {
    // B/C/D/E：純型態 + 淘汰法
    if (evaluateElimination(candles, idx).eliminated) return null;

    let matched = false;
    if (strategy === 'B' && detectBreakoutEntry(candles, idx)) matched = true;
    else if (strategy === 'C' && detectVReversal(candles, idx)) matched = true;
    else if (strategy === 'D' && detectStrategyD(candles, idx)) matched = true;
    else if (strategy === 'E' && detectStrategyE(candles, idx)) matched = true;
    if (!matched) return null;
  }

  // 高勝率分數（所有策略都算，供排序因子用）
  try {
    highWinRateScore = evaluateHighWinRateEntry(candles, idx).score;
  } catch { highWinRateScore = 0; }

  return buildFeatures(symbol, name, candles, idx, {
    sixConditionsScore: sixScore,
    highWinRateScore,
    mtfScore,
    deviation,
  });
}

// ══════════════════════════════════════════════════════════════
// 計算某候選 T+1 進場後 d1~d5 報酬
// ══════════════════════════════════════════════════════════════

function computeForwardReturns(
  candles: CandleWithIndicators[],
  idx: number,
): { entryPrice: number; d1: number; d2: number; d3: number; d4: number; d5: number; d5Abs: number } | null {
  if (idx + 5 >= candles.length) return null;
  const next = candles[idx + 1];
  if (!next || next.open <= 0) return null;
  // 隔天一字跌停：無法買入
  const nextRange = next.high - next.low;
  if (next.open === next.high && next.low > 0 && nextRange / next.low * 100 < 0.5) return null;

  const entryPrice = next.open * (1 + SLIPPAGE_PCT);
  const ret = (p: number) => ((p - entryPrice) / entryPrice) * 100;

  return {
    entryPrice: +entryPrice.toFixed(4),
    d1: +ret(candles[idx + 1].close).toFixed(4),
    d2: +ret(candles[idx + 2].close).toFixed(4),
    d3: +ret(candles[idx + 3].close).toFixed(4),
    d4: +ret(candles[idx + 4].close).toFixed(4),
    d5: +ret(candles[idx + 5].close).toFixed(4),
    d5Abs: +candles[idx + 5].close.toFixed(4),
  };
}

// ══════════════════════════════════════════════════════════════
// 主迴圈：對某市場 × 期間 × 策略，跑所有交易日、產生每個因子的 #1
// ══════════════════════════════════════════════════════════════

function listTradingDays(stocks: Map<string, StockData>, start: string, end: string): string[] {
  const set = new Set<string>();
  for (const sd of stocks.values()) {
    for (const c of sd.candles) {
      const d = c.date?.slice(0, 10);
      if (d && d >= start && d <= end) set.add(d);
    }
  }
  return Array.from(set).sort();
}

function runCombo(
  market: Market,
  periodKey: 'P1' | 'P2' | 'P3',
  strategy: StrategyCode,
  sortFactors: SortFactorName[],
  stocks: Map<string, StockData>,
  topNSet: Set<string> | null,
): TradeRecord[] {
  const { start, end } = PERIODS[periodKey];
  const days = listTradingDays(stocks, start, end);
  const records: TradeRecord[] = [];

  for (const date of days) {
    // 建當日候選池
    const pool: CandidateFeatures[] = [];
    for (const [sym, sd] of stocks) {
      if (topNSet && !topNSet.has(sym)) continue;
      const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 0) continue;
      const feat = buildCandidate(strategy, sym, sd.name, sd.candles, idx);
      if (feat) pool.push(feat);
    }

    if (pool.length === 0) continue;

    // 對每個排序因子：取 #1，算 d1~d5
    for (const sortFactor of sortFactors) {
      const sortFn = SORT_DEFS[sortFactor];
      const ranked = [...pool].sort((a, b) => sortFn(b) - sortFn(a));
      const pick = ranked[0];
      if (!pick) continue;

      const fwd = computeForwardReturns(pick.candles, pick.idx);
      if (!fwd) continue;

      records.push({
        market, period: periodKey, strategy, sortFactor,
        date, symbol: pick.symbol, name: pick.name,
        entryPrice: fwd.entryPrice,
        d1: fwd.d1, d2: fwd.d2, d3: fwd.d3, d4: fwd.d4, d5: fwd.d5,
        d5Abs: fwd.d5Abs,
      });
    }
  }

  return records;
}

// ══════════════════════════════════════════════════════════════
// 聚合統計
// ══════════════════════════════════════════════════════════════

interface Aggregate {
  market: Market;
  period: 'P1' | 'P2' | 'P3';
  strategy: StrategyCode;
  sortFactor: SortFactorName;
  nTrades: number;
  d5Mean: number;
  d5Winrate: number;
  d5P10: number; d5P25: number; d5Median: number; d5P75: number; d5P90: number;
  tailRisk: number;  // d5 < -5% 比例
  maxIntraDD: number; // d1~d5 最低值的平均
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function aggregate(records: TradeRecord[]): Aggregate[] {
  const groups = new Map<string, TradeRecord[]>();
  for (const r of records) {
    const key = `${r.market}|${r.period}|${r.strategy}|${r.sortFactor}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const out: Aggregate[] = [];
  for (const [key, arr] of groups) {
    const [market, period, strategy, sortFactor] = key.split('|') as [Market, 'P1' | 'P2' | 'P3', StrategyCode, SortFactorName];
    const d5s = arr.map(x => x.d5).sort((a, b) => a - b);
    const d5Mean = d5s.reduce((s, x) => s + x, 0) / d5s.length;
    const d5Winrate = d5s.filter(x => x > 0).length / d5s.length;
    const tailRisk = d5s.filter(x => x < -5).length / d5s.length;
    const intraMin = arr.map(r => Math.min(r.d1, r.d2, r.d3, r.d4, r.d5));
    const maxIntraDD = intraMin.reduce((s, x) => s + x, 0) / intraMin.length;

    out.push({
      market, period, strategy, sortFactor,
      nTrades: arr.length,
      d5Mean: +d5Mean.toFixed(3),
      d5Winrate: +d5Winrate.toFixed(3),
      d5P10: +percentile(d5s, 0.10).toFixed(3),
      d5P25: +percentile(d5s, 0.25).toFixed(3),
      d5Median: +percentile(d5s, 0.50).toFixed(3),
      d5P75: +percentile(d5s, 0.75).toFixed(3),
      d5P90: +percentile(d5s, 0.90).toFixed(3),
      tailRisk: +tailRisk.toFixed(3),
      maxIntraDD: +maxIntraDD.toFixed(3),
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
// Top-N 預篩（20日均成交額）
// ══════════════════════════════════════════════════════════════

function buildTopNSet(stocks: Map<string, StockData>, refDate: string, n: number): Set<string> | null {
  if (n <= 0) return null;
  const list: { symbol: string; avg: number }[] = [];
  for (const [sym, sd] of stocks) {
    const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === refDate);
    if (idx < 20) continue;
    let sum = 0, cnt = 0;
    for (let i = idx - 20; i < idx; i++) {
      sum += sd.candles[i].volume * sd.candles[i].close;
      cnt++;
    }
    list.push({ symbol: sym, avg: cnt > 0 ? sum / cnt : 0 });
  }
  list.sort((a, b) => b.avg - a.avg);
  return new Set(list.slice(0, n).map(x => x.symbol));
}

// ══════════════════════════════════════════════════════════════
// 輸出
// ══════════════════════════════════════════════════════════════

function writeOutputs(records: TradeRecord[], aggs: Aggregate[], ts: string): void {
  const outDir = path.join(process.cwd(), 'data', 'backtest-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 逐筆 CSV
  const tradesPath = path.join(outDir, `sort-matrix-${ts}-trades.csv`);
  const header = 'market,period,strategy,sortFactor,date,symbol,name,entryPrice,d1,d2,d3,d4,d5\n';
  const body = records.map(r =>
    [r.market, r.period, r.strategy, r.sortFactor, r.date, r.symbol, `"${r.name}"`,
     r.entryPrice, r.d1, r.d2, r.d3, r.d4, r.d5].join(',')
  ).join('\n');
  fs.writeFileSync(tradesPath, header + body + '\n');
  console.log(`  ✅ trades CSV：${tradesPath}  (${records.length} 筆)`);

  // summary pivot markdown
  const summaryPath = path.join(outDir, `sort-matrix-${ts}-summary.md`);
  let md = `# 排序因子矩陣回測 Summary\n\n`;
  md += `*Generated: ${new Date().toISOString()}*\n\n`;
  md += `Total records: ${records.length}\n\n`;
  md += `## 聚合統計（市場 × 期間 × 策略 × 排序因子）\n\n`;
  md += `| 市場 | 期間 | 策略 | 排序因子 | N | d5 平均 | 勝率 | Median | P10 | P90 | 尾部風險 |\n`;
  md += `|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|\n`;
  const sorted = [...aggs].sort((a, b) => {
    if (a.market !== b.market) return a.market.localeCompare(b.market);
    if (a.period !== b.period) return a.period.localeCompare(b.period);
    if (a.strategy !== b.strategy) return a.strategy.localeCompare(b.strategy);
    return b.d5Mean - a.d5Mean;
  });
  for (const a of sorted) {
    md += `| ${a.market} | ${a.period} | ${a.strategy} | ${a.sortFactor} | ${a.nTrades} | ${a.d5Mean.toFixed(2)}% | ${(a.d5Winrate*100).toFixed(1)}% | ${a.d5Median.toFixed(2)}% | ${a.d5P10.toFixed(2)}% | ${a.d5P90.toFixed(2)}% | ${(a.tailRisk*100).toFixed(1)}% |\n`;
  }
  md += `\n## Top-10 排序因子 per 市場 × 策略 × 期間\n\n`;
  const groups = new Map<string, Aggregate[]>();
  for (const a of aggs) {
    const k = `${a.market}|${a.period}|${a.strategy}`;
    const arr = groups.get(k) ?? [];
    arr.push(a);
    groups.set(k, arr);
  }
  for (const [k, arr] of [...groups.entries()].sort()) {
    const [m, p, s] = k.split('|');
    md += `### ${m} ${p} 策略 ${s}\n\n`;
    md += `| 排名 | 排序因子 | N | d5 平均 | 勝率 |\n|---:|---|---:|---:|---:|\n`;
    const top = arr.sort((a, b) => b.d5Mean - a.d5Mean).slice(0, 10);
    top.forEach((a, i) => {
      md += `| ${i + 1} | ${a.sortFactor} | ${a.nTrades} | ${a.d5Mean.toFixed(2)}% | ${(a.d5Winrate*100).toFixed(1)}% |\n`;
    });
    md += `\n`;
  }
  fs.writeFileSync(summaryPath, md);
  console.log(`  ✅ summary：${summaryPath}`);

  // stability — 跨 P1/P2/P3 CV
  const stabilityPath = path.join(outDir, `sort-matrix-${ts}-stability.md`);
  const stabGroups = new Map<string, Aggregate[]>();
  for (const a of aggs) {
    const k = `${a.market}|${a.strategy}|${a.sortFactor}`;
    const arr = stabGroups.get(k) ?? [];
    arr.push(a);
    stabGroups.set(k, arr);
  }
  let sm = `# 跨期間穩定性（CV = stdev/|mean|）\n\n`;
  sm += `篩選條件：三期都有資料、d5 平均皆 > 0。CV 越低越穩定。\n\n`;
  sm += `| 市場 | 策略 | 排序因子 | P1_d5 | P2_d5 | P3_d5 | 均值 | CV | N合計 | 標籤 |\n`;
  sm += `|---|---|---|---:|---:|---:|---:|---:|---:|---|\n`;
  const stabRows: Array<{ key: string; row: string; cv: number; mean: number }> = [];
  for (const [k, arr] of stabGroups) {
    if (arr.length < 3) continue;
    const [market, strategy, sortFactor] = k.split('|');
    const byPeriod = new Map(arr.map(a => [a.period, a]));
    const p1 = byPeriod.get('P1'), p2 = byPeriod.get('P2'), p3 = byPeriod.get('P3');
    if (!p1 || !p2 || !p3) continue;
    const vals = [p1.d5Mean, p2.d5Mean, p3.d5Mean];
    const mean = vals.reduce((s, x) => s + x, 0) / 3;
    const variance = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / 3;
    const std = Math.sqrt(variance);
    const cv = Math.abs(mean) > 0.001 ? std / Math.abs(mean) : 99;
    const n = p1.nTrades + p2.nTrades + p3.nTrades;
    const tag = mean > 0 && cv < 0.5 ? '⭐ 穩定推薦'
              : mean > 0 && cv < 1 ? '○ 可用'
              : mean <= 0 ? '✗ 期望值非正' : '△ 波動大';
    stabRows.push({
      key: k, cv, mean,
      row: `| ${market} | ${strategy} | ${sortFactor} | ${p1.d5Mean.toFixed(2)}% | ${p2.d5Mean.toFixed(2)}% | ${p3.d5Mean.toFixed(2)}% | ${mean.toFixed(2)}% | ${cv.toFixed(2)} | ${n} | ${tag} |`,
    });
  }
  stabRows.sort((a, b) => (b.mean - a.mean) - 0.5 * (b.cv - a.cv));
  for (const r of stabRows) sm += r.row + '\n';
  fs.writeFileSync(stabilityPath, sm);
  console.log(`  ✅ stability：${stabilityPath}`);
}

// ══════════════════════════════════════════════════════════════
// main
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`\n排序因子矩陣回測\n`);
  console.log(`MARKET=${ENV.MARKET}  PERIOD=${ENV.PERIOD}  STRATEGY=${ENV.STRATEGY}  SORT=${ENV.SORT}  TOP_N=${ENV.TOP_N}\n`);

  const markets: Market[] = ENV.MARKET === 'BOTH' ? ['TW', 'CN'] : [ENV.MARKET as Market];
  const periods = ENV.PERIOD === 'ALL' ? (['P1', 'P2', 'P3'] as const) : [ENV.PERIOD as 'P1' | 'P2' | 'P3'];
  const strategies: StrategyCode[] = ENV.STRATEGY === 'ALL' ? ALL_STRATEGIES : [ENV.STRATEGY as StrategyCode];
  const factors: SortFactorName[] = ENV.SORT === 'ALL' ? ALL_SORT_FACTORS : [ENV.SORT as SortFactorName];

  const allRecords: TradeRecord[] = [];

  for (const market of markets) {
    console.log(`\n── 市場 ${market} ──`);
    const stocks = loadStocks(market);
    if (stocks.size === 0) { console.log('  無資料，跳過'); continue; }

    for (const period of periods) {
      const pInfo = PERIODS[period];
      const topNSet = ENV.TOP_N > 0 ? buildTopNSet(stocks, pInfo.end, ENV.TOP_N) : null;
      console.log(`\n  期間 ${period} (${pInfo.start} ~ ${pInfo.end}, ${pInfo.label})${topNSet ? ` [top${ENV.TOP_N}]` : ''}`);

      for (const strategy of strategies) {
        process.stdout.write(`    策略 ${strategy}... `);
        const t0 = Date.now();
        const recs = runCombo(market, period, strategy, factors, stocks, topNSet);
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`${recs.length} 筆 (${dt}s)`);
        allRecords.push(...recs);
      }
    }
  }

  console.log(`\n聚合中...`);
  const aggs = aggregate(allRecords);
  console.log(`  ${aggs.length} 組 (市場×期間×策略×因子)`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  console.log(`\n寫出結果...`);
  writeOutputs(allRecords, aggs, ts);

  // Console top summary
  console.log(`\n─── Top 10 全局組合（d5 平均降冪） ───`);
  const top = [...aggs].sort((a, b) => b.d5Mean - a.d5Mean).slice(0, 10);
  for (const a of top) {
    console.log(
      `  ${a.market} ${a.period} ${a.strategy.padEnd(6)} ${a.sortFactor.padEnd(8)} ` +
      `N=${String(a.nTrades).padStart(3)} d5=${a.d5Mean.toFixed(2).padStart(7)}% ` +
      `勝率=${(a.d5Winrate*100).toFixed(1).padStart(5)}%`
    );
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
