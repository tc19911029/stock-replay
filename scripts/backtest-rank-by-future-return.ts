/**
 * 哪個策略 × 排序的「排序第一名」隔天/隔三天漲最多？
 *
 * 對每個 (letter, sort, market)，每天取排序第 1 名，記錄：
 *   d1_close = (close[T+1] - close[T0]) / close[T0] × 100
 *   d3_close = (close[T+3] - close[T0]) / close[T0] × 100
 *
 * 輸出 per (策略 × 排序) 的 d1/d3 平均、中位、picks 數。
 *
 * Usage:
 *   BACKTEST_START=2025-05-12 BACKTEST_END=2026-05-12 BACKTEST_LABEL=1y \
 *     NODE_OPTIONS="--max-old-space-size=12288" npx tsx scripts/backtest-rank-by-future-return.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { evaluateStockV12 } from '@/lib/scanner/v12StockEvaluator';
import type { V12Letter } from '@/lib/analysis/v12Signals';
import type { CandleWithIndicators } from '@/types';
import { detectBreakoutEntry, detectConsolidationBreakout } from '@/lib/analysis/breakoutEntry';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';

const CONFIG = {
  startDate: process.env.BACKTEST_START ?? '2026-01-01',
  endDate: process.env.BACKTEST_END ?? '2026-05-12',
  label: process.env.BACKTEST_LABEL ?? '',
  letters: ['B','C','D','E','F','J','K','L','M','N','O','P','Q'] as const,
  sorts: ['漲幅', '六條件', '成交額排名', '面板對齊'] as const,
  topNTurnover: 500,
  minPicksForGrade: 30,
};

const STRATEGY_NAME: Record<string, string> = {
  B: '回後買上漲', C: '盤整突破', D: '一字底突破', E: '缺口進場',
  F: 'V 形反轉', J: 'ABC 突破', K: 'K 線橫盤突破', L: '過大量黑 K 高',
  M: '突破上升軌道線', N: '型態確認', O: '打底完成', P: '高檔拉回',
  Q: '三均線戰法',
};

const TRACK_LABEL: Record<string, string> = {
  B: '多頭', C: '多頭', E: '多頭', M: '多頭', P: '多頭',
  J: '多頭', K: '多頭', L: '多頭',
  D: '反轉', F: '反轉', N: '反轉', O: '反轉',
  Q: '戰法',
};

const BULLISH_REQUIRES_STEP1 = new Set(['B', 'C', 'E', 'M', 'P', 'J', 'K', 'L']);
const ROOT = path.join(process.cwd(), 'data');
const CANDLE_ROOT = path.join(ROOT, 'candles');
const SUFFIX = CONFIG.label ? '_' + CONFIG.label : '';
const OUT_JSON = path.join(ROOT, `backtest_rank_future${SUFFIX}.json`);
const OUT_MD_DIR = path.join(ROOT, 'backtest-output');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_MD = path.join(OUT_MD_DIR, `rank-future${CONFIG.label ? '-' + CONFIG.label : ''}-${TODAY}.md`);

interface StockData {
  symbol: string;
  name: string;
  market: 'TW' | 'CN';
  candles: CandleWithIndicators[];
  dateToIdx: Map<string, number>;
}

interface PickReturn {
  date: string;
  symbol: string;
  name: string;
  d1: number | null;
  d3: number | null;
}

interface EvalEvent {
  market: 'TW' | 'CN';
  date: string;
  symbol: string;
  name: string;
  matchedMethods: V12Letter[];
  sixConditionsScore: number;
  step1Passed: boolean;
  changePercent: number;
  turnoverRank: number;
  d1Close: number | null;
  d3Close: number | null;
}

interface CellStats {
  market: 'TW' | 'CN';
  letter: string;
  letterName: string;
  sort: string;
  track: string;
  picks: number;
  d1Mean: number;
  d1Median: number;
  d3Mean: number;
  d3Median: number;
  // 最近 3 筆 picks 拿來舉例
  recent: PickReturn[];
}

function loadMarketStocks(market: 'TW' | 'CN'): StockData[] {
  const dir = path.join(CANDLE_ROOT, market);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const isIndex = (s: string) => s.startsWith('^') || s === '000001.SS' || s === '000001.SZ' || s === '000300.SS';
  const list: StockData[] = [];
  let loaded = 0;
  process.stdout.write(`  讀取 ${market} L1`);
  for (const f of files) {
    const symbol = f.replace('.json', '');
    if (isIndex(symbol)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const rawCandles = Array.isArray(raw) ? raw : raw.candles ?? [];
      const name = (raw as { name?: string }).name ?? symbol;
      if (typeof name === 'string' && name.includes('ST')) continue;
      const candles: CandleWithIndicators[] = rawCandles.map((c: { date?: string; open?: number; close?: number; high?: number; low?: number; volume?: number }) => ({
        date: (c.date ?? '').slice(0, 10),
        open: Number(c.open) || 0,
        high: Number(c.high) || 0,
        low: Number(c.low) || 0,
        close: Number(c.close) || 0,
        volume: Number(c.volume) || 0,
      } as CandleWithIndicators));
      if (candles.length < 60) continue;
      const withIndicators = computeIndicators(candles);
      const dateToIdx = new Map<string, number>();
      withIndicators.forEach((c, i) => dateToIdx.set(c.date.slice(0, 10), i));
      list.push({ symbol, name, market, candles: withIndicators, dateToIdx });
      loaded++;
      if (loaded % 200 === 0) process.stdout.write('.');
    } catch { /* skip */ }
  }
  console.log(` → ${loaded} 支`);
  return list;
}

function loadIndexCandles(market: 'TW' | 'CN'): CandleWithIndicators[] {
  const symbol = market === 'TW' ? '^TWII' : '000001.SS';
  const file = path.join(CANDLE_ROOT, market, `${symbol}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const rawCandles = Array.isArray(raw) ? raw : raw.candles ?? [];
    const candles: CandleWithIndicators[] = rawCandles.map((c: { date?: string; open?: number; close?: number; high?: number; low?: number; volume?: number }) => ({
      date: (c.date ?? '').slice(0, 10),
      open: Number(c.open) || 0,
      high: Number(c.high) || 0,
      low: Number(c.low) || 0,
      close: Number(c.close) || 0,
      volume: Number(c.volume) || 0,
    } as CandleWithIndicators));
    return computeIndicators(candles);
  } catch { return []; }
}

function computeFutureCloseReturn(stock: StockData, t0Date: string, daysAhead: number): number | null {
  const t0 = stock.dateToIdx.get(t0Date);
  if (t0 == null) return null;
  if (t0 + daysAhead >= stock.candles.length) return null;
  const entry = stock.candles[t0].close;
  if (entry <= 0) return null;
  const future = stock.candles[t0 + daysAhead].close;
  return (future - entry) / entry * 100;
}

function turnoverRankForDay(stocks: StockData[], date: string): Map<string, number> {
  const list: { symbol: string; turnover: number }[] = [];
  for (const s of stocks) {
    const idx = s.dateToIdx.get(date);
    if (idx == null) continue;
    const c = s.candles[idx];
    list.push({ symbol: s.symbol, turnover: c.close * c.volume });
  }
  list.sort((a, b) => b.turnover - a.turnover);
  const rank = new Map<string, number>();
  list.forEach((x, i) => rank.set(x.symbol, i + 1));
  return rank;
}

function collectEvents(market: 'TW' | 'CN', stocks: StockData[], indexCandles: CandleWithIndicators[]): EvalEvent[] {
  const events: EvalEvent[] = [];
  const dateSet = new Set<string>();
  for (const s of stocks) {
    for (const c of s.candles) {
      const d = c.date.slice(0, 10);
      if (d >= CONFIG.startDate && d <= CONFIG.endDate) dateSet.add(d);
    }
  }
  const dates = [...dateSet].sort();
  console.log(`  ${market} 期間交易日：${dates.length} 天`);

  const indexDateToIdx = new Map<string, number>();
  indexCandles.forEach((c, i) => indexDateToIdx.set(c.date.slice(0, 10), i));

  let processed = 0;
  for (const date of dates) {
    const idxIdx = indexDateToIdx.get(date);
    if (idxIdx == null) continue;
    const indexSlice = indexCandles.slice(0, idxIdx + 1);
    const rank = turnoverRankForDay(stocks, date);

    for (const s of stocks) {
      const idx = s.dateToIdx.get(date);
      if (idx == null || idx < 60) continue;
      const r = rank.get(s.symbol);
      if (r == null || r > CONFIG.topNTurnover) continue;

      try {
        const result = evaluateStockV12({
          symbol: s.symbol, name: s.name, market: s.market,
          candles: s.candles, indexCandles: indexSlice, index: idx,
        });
        const triggered: V12Letter[] = result.signals.filter(sig => sig.triggered).map(sig => sig.letter);

        const marketPassed = result.marketGate.passed;
        const isLongTrend = result.step1.trendState === '多頭';
        if (marketPassed && isLongTrend) {
          if (detectBreakoutEntry(s.candles, idx)) triggered.push('B' as V12Letter);
          if (detectConsolidationBreakout(s.candles, idx)) triggered.push('C' as V12Letter);
          if (detectStrategyD(s.candles, idx)) triggered.push('E' as V12Letter);
        }
        if (detectStrategyE(s.candles, idx)) triggered.push('D' as V12Letter);
        if (detectVReversal(s.candles, idx)) triggered.push('F' as V12Letter);

        if (triggered.length === 0) continue;

        const prev = idx > 0 ? s.candles[idx - 1] : null;
        const changePercent = prev && prev.close > 0 ? (s.candles[idx].close - prev.close) / prev.close * 100 : 0;
        const indicatorOK = result.step1.indicatorPassed;
        const volumeNormalOrClimax = result.step1.volumeLevel != null;
        const step1Passed = isLongTrend && indicatorOK && volumeNormalOrClimax;
        const sixScore = (isLongTrend ? 3 : 0) + (indicatorOK ? 2 : 0) + (volumeNormalOrClimax ? 1 : 0);

        events.push({
          market: s.market, date,
          symbol: s.symbol, name: s.name,
          matchedMethods: triggered,
          sixConditionsScore: sixScore,
          step1Passed,
          changePercent,
          turnoverRank: r,
          d1Close: computeFutureCloseReturn(s, date, 1),
          d3Close: computeFutureCloseReturn(s, date, 3),
        });
      } catch { /* skip */ }
    }
    processed++;
    if (processed % 20 === 0) process.stdout.write(`    [${market}] ${processed}/${dates.length}\n`);
  }
  return events;
}

type SortKey = (e: EvalEvent) => number;
const SORT_FNS: Record<typeof CONFIG.sorts[number], SortKey> = {
  '漲幅': e => e.changePercent,
  '六條件': e => e.sixConditionsScore * 100 + e.changePercent / 100,
  '成交額排名': e => -e.turnoverRank,
  '面板對齊': e => e.changePercent * 1000 + e.sixConditionsScore,
};

function passesProductionGate(letter: string, e: EvalEvent): boolean {
  if (BULLISH_REQUIRES_STEP1.has(letter)) return e.step1Passed;
  return true;
}

function mean(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round(x: number, p = 2): number { const f = Math.pow(10, p); return Math.round(x * f) / f; }
function fmtSigned(x: number): string { return (x >= 0 ? '+' : '') + x.toFixed(2); }

function summarizeCell(market: 'TW' | 'CN', letter: string, sort: string, events: EvalEvent[]): CellStats {
  const sortFn = SORT_FNS[sort as typeof CONFIG.sorts[number]];
  // 每天取 top-1
  const byDay = new Map<string, EvalEvent[]>();
  for (const e of events) {
    if (e.market !== market) continue;
    if (!e.matchedMethods.includes(letter as V12Letter)) continue;
    if (!passesProductionGate(letter, e)) continue;
    const arr = byDay.get(e.date) ?? [];
    arr.push(e);
    byDay.set(e.date, arr);
  }
  const picks: PickReturn[] = [];
  for (const [, arr] of byDay) {
    arr.sort((a, b) => sortFn(b) - sortFn(a));
    const top = arr[0];
    picks.push({
      date: top.date,
      symbol: top.symbol,
      name: top.name,
      d1: top.d1Close,
      d3: top.d3Close,
    });
  }
  picks.sort((a, b) => a.date.localeCompare(b.date));
  const d1List = picks.map(p => p.d1).filter((x): x is number => x != null);
  const d3List = picks.map(p => p.d3).filter((x): x is number => x != null);

  return {
    market,
    letter,
    letterName: STRATEGY_NAME[letter] ?? letter,
    sort,
    track: TRACK_LABEL[letter] ?? '-',
    picks: picks.length,
    d1Mean: round(mean(d1List)),
    d1Median: round(median(d1List)),
    d3Mean: round(mean(d3List)),
    d3Median: round(median(d3List)),
    recent: picks.slice(-5),
  };
}

function writeMarkdown(cells: CellStats[]): void {
  if (!fs.existsSync(OUT_MD_DIR)) fs.mkdirSync(OUT_MD_DIR, { recursive: true });
  const lines: string[] = [];
  lines.push(`# 「排序第一名隔天/隔三天漲幅」排行（${CONFIG.startDate} → ${CONFIG.endDate}）`);
  lines.push('');
  lines.push(`產出時間：${new Date().toISOString()}　|　Label: ${CONFIG.label || '(default)'}`);
  lines.push('');
  lines.push('**規則**：每天每個 (策略 × 排序) 取符合條件的排序第 1 名股票，記錄 d1/d3 close 報酬。');
  lines.push('- d1 = (T+1 收盤 − T0 收盤) / T0 收盤 × 100');
  lines.push('- d3 = (T+3 收盤 − T0 收盤) / T0 收盤 × 100');
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const mkt of ['TW', 'CN'] as const) {
    lines.push(`## ${mkt}`);
    lines.push('');
    // d1 排行
    lines.push('### d1（T+1 收盤）排行 — 依「平均」排序、top 15');
    lines.push('');
    lines.push('| 策略 | 排序 | picks | d1 平均% | d1 中位% | d3 平均% | d3 中位% |');
    lines.push('|---|---|---:|---:|---:|---:|---:|');
    const d1Sorted = cells.filter(c => c.market === mkt && c.picks >= 5).sort((a, b) => b.d1Mean - a.d1Mean);
    for (const c of d1Sorted.slice(0, 15)) {
      lines.push(`| **${c.letterName}** | ${c.sort} | ${c.picks} | ${fmtSigned(c.d1Mean)} | ${fmtSigned(c.d1Median)} | ${fmtSigned(c.d3Mean)} | ${fmtSigned(c.d3Median)} |`);
    }
    lines.push('');

    // d3 排行
    lines.push('### d3（T+3 收盤）排行 — 依「平均」排序、top 15');
    lines.push('');
    lines.push('| 策略 | 排序 | picks | d3 平均% | d3 中位% | d1 平均% | d1 中位% |');
    lines.push('|---|---|---:|---:|---:|---:|---:|');
    const d3Sorted = cells.filter(c => c.market === mkt && c.picks >= 5).sort((a, b) => b.d3Mean - a.d3Mean);
    for (const c of d3Sorted.slice(0, 15)) {
      lines.push(`| **${c.letterName}** | ${c.sort} | ${c.picks} | ${fmtSigned(c.d3Mean)} | ${fmtSigned(c.d3Median)} | ${fmtSigned(c.d1Mean)} | ${fmtSigned(c.d1Median)} |`);
    }
    lines.push('');

    // 範例：top 3 d1 + top 3 d3 的最近 picks
    lines.push('### 範例：d1 / d3 平均最高的組合最近 5 個 picks（具體股票）');
    lines.push('');
    const examples = [...d1Sorted.slice(0, 3), ...d3Sorted.slice(0, 3)];
    const seen = new Set<string>();
    for (const c of examples) {
      const key = `${c.letter}|${c.sort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`**${c.letterName} × ${c.sort}**（d1 平均 ${fmtSigned(c.d1Mean)}%、d3 平均 ${fmtSigned(c.d3Mean)}%、picks ${c.picks}）：`);
      lines.push('');
      lines.push('| 日期 | 代號 | 名稱 | d1% | d3% |');
      lines.push('|---|---|---|---:|---:|');
      for (const p of c.recent) {
        lines.push(`| ${p.date} | ${p.symbol} | ${p.name} | ${p.d1 != null ? fmtSigned(p.d1) : '—'} | ${p.d3 != null ? fmtSigned(p.d3) : '—'} |`);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  fs.writeFileSync(OUT_MD, lines.join('\n'));
  console.log(`  寫入 ${path.relative(process.cwd(), OUT_MD)}`);
}

function main(): void {
  const startTime = Date.now();
  console.log('\n  ═══ 隔天/隔三天漲幅排行回測 ═══');
  console.log(`  期間：${CONFIG.startDate} → ${CONFIG.endDate}${CONFIG.label ? ` (label=${CONFIG.label})` : ''}`);

  const twStocks = loadMarketStocks('TW');
  const cnStocks = loadMarketStocks('CN');
  const twIndex = loadIndexCandles('TW');
  const cnIndex = loadIndexCandles('CN');

  console.log('\n  跑 v12 detector + 算 d1/d3 close...');
  const twEvents = collectEvents('TW', twStocks, twIndex);
  console.log(`    TW events: ${twEvents.length}`);
  const cnEvents = collectEvents('CN', cnStocks, cnIndex);
  console.log(`    CN events: ${cnEvents.length}`);
  const allEvents = [...twEvents, ...cnEvents];

  console.log('\n  計算 cells...');
  const cells: CellStats[] = [];
  for (const mkt of ['TW', 'CN'] as const) {
    for (const L of CONFIG.letters) {
      for (const sort of CONFIG.sorts) {
        cells.push(summarizeCell(mkt, L, sort, allEvents));
      }
    }
  }

  console.log('\n  ═══ TW d1 排行 top 5 ═══');
  const twD1 = cells.filter(c => c.market === 'TW' && c.picks >= CONFIG.minPicksForGrade).sort((a, b) => b.d1Mean - a.d1Mean);
  twD1.slice(0, 5).forEach((c, i) => {
    console.log(`  ${i + 1}. ${(c.letterName + '              ').slice(0, 14)} × ${(c.sort + '        ').slice(0, 8)} | picks=${String(c.picks).padStart(4)} | d1=${fmtSigned(c.d1Mean)}% (中位 ${fmtSigned(c.d1Median)}%) | d3=${fmtSigned(c.d3Mean)}%`);
  });
  console.log('\n  ═══ TW d3 排行 top 5 ═══');
  const twD3 = cells.filter(c => c.market === 'TW' && c.picks >= CONFIG.minPicksForGrade).sort((a, b) => b.d3Mean - a.d3Mean);
  twD3.slice(0, 5).forEach((c, i) => {
    console.log(`  ${i + 1}. ${(c.letterName + '              ').slice(0, 14)} × ${(c.sort + '        ').slice(0, 8)} | picks=${String(c.picks).padStart(4)} | d3=${fmtSigned(c.d3Mean)}% (中位 ${fmtSigned(c.d3Median)}%) | d1=${fmtSigned(c.d1Mean)}%`);
  });
  console.log('\n  ═══ CN d1 排行 top 5 ═══');
  const cnD1 = cells.filter(c => c.market === 'CN' && c.picks >= CONFIG.minPicksForGrade).sort((a, b) => b.d1Mean - a.d1Mean);
  cnD1.slice(0, 5).forEach((c, i) => {
    console.log(`  ${i + 1}. ${(c.letterName + '              ').slice(0, 14)} × ${(c.sort + '        ').slice(0, 8)} | picks=${String(c.picks).padStart(4)} | d1=${fmtSigned(c.d1Mean)}% (中位 ${fmtSigned(c.d1Median)}%) | d3=${fmtSigned(c.d3Mean)}%`);
  });
  console.log('\n  ═══ CN d3 排行 top 5 ═══');
  const cnD3 = cells.filter(c => c.market === 'CN' && c.picks >= CONFIG.minPicksForGrade).sort((a, b) => b.d3Mean - a.d3Mean);
  cnD3.slice(0, 5).forEach((c, i) => {
    console.log(`  ${i + 1}. ${(c.letterName + '              ').slice(0, 14)} × ${(c.sort + '        ').slice(0, 8)} | picks=${String(c.picks).padStart(4)} | d3=${fmtSigned(c.d3Mean)}% (中位 ${fmtSigned(c.d3Median)}%) | d1=${fmtSigned(c.d1Mean)}%`);
  });

  fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), config: CONFIG, cells }, null, 2));
  console.log(`\n  寫入 ${path.relative(process.cwd(), OUT_JSON)}`);
  writeMarkdown(cells);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  完成（${elapsed} 秒）\n`);
}

main();
