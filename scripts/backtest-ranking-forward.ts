#!/usr/bin/env tsx
/**
 * 排序因子「#1 股票前瞻漲幅」比較
 *
 * 對每個交易日 D：
 *   1. 掃描 D 日所有符合條件的股票（六條件+戒律+淘汰法+MTF）
 *   2. 對每個排序因子 F：
 *      - 取排序第 1 名
 *      - 記錄 (D+1 close - D close) / D close = d1 漲幅
 *      - 記錄 (D+2 close - D close) / D close = d2 漲幅
 *      - 記錄 (D+3 close - D close) / D close = d3 漲幅
 *   3. 彙整每個因子的平均 d1/d2/d3 漲幅 + 勝率
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-ranking-forward.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { evaluateMultiTimeframe } from '@/lib/analysis/multiTimeframeFilter';
import { evaluateHighWinRateEntry } from '@/lib/analysis/highWinRateEntry';
import { checkLongProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import type { CandleWithIndicators } from '@/types';
import { BASE_THRESHOLDS, ZHU_OPTIMIZED } from '@/lib/strategy/StrategyConfig';

// ══════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════

const MARKET: 'TW' | 'CN' = 'TW';

const PERIODS: { name: string; start: string; end: string }[] = [
  { name: '2026 Q1',  start: '2026-01-02', end: '2026-03-31' },
  { name: '過去 1 年', start: '2025-04-18', end: '2026-04-17' },
  { name: '過去 2 年', start: '2024-04-18', end: '2026-04-17' },
];

const CONFIGS: { name: string; topN: number; useMtf: boolean }[] = [
  { name: 'Top500 + MTF', topN: 500, useMtf: true  },
  { name: 'Top500 無MTF', topN: 500, useMtf: false },
  { name: 'Top200 + MTF', topN: 200, useMtf: true  },
  { name: 'Top200 無MTF', topN: 200, useMtf: false },
];

const MTF_CFG = { ...BASE_THRESHOLDS, multiTimeframeFilter: true };

// ══════════════════════════════════════════════════════════════

interface StockData { name: string; candles: CandleWithIndicators[] }

interface Features {
  symbol: string; name: string; idx: number; candles: CandleWithIndicators[];
  close: number;
  totalScore: number; changePercent: number;
  volumeRatio: number; bodyPct: number; deviation: number;
  mom5: number; turnover: number;
  highWinRateScore: number; mtfScore: number;
}

type SortFn = (f: Features) => number;

const SORT_FACTORS: Record<string, SortFn> = {
  '六條件總分':   f => f.totalScore * 1000 + f.highWinRateScore * 10 + f.changePercent / 100,
  '高勝率':       f => f.highWinRateScore + f.changePercent / 10,
  '成交額':       f => Math.log10(Math.max(f.turnover, 1)),
  '量比':         f => Math.min(f.volumeRatio, 5) * 2 + f.changePercent / 10,
  '動能':         f => f.mom5 + f.changePercent / 10,
  'K棒實體':      f => f.bodyPct * 100 + f.changePercent / 10,
  '乖離率低':     f => -f.deviation * 100 + f.changePercent / 10,
  '漲幅':         f => f.changePercent,
  '綜合因子':     f => Math.min(f.volumeRatio, 5) / 5 + Math.max(0, f.mom5) / 20
                     + Math.min(f.bodyPct * 100, 10) / 10 + f.changePercent / 10,
};

// ══════════════════════════════════════════════════════════════
// 載入股票
// ══════════════════════════════════════════════════════════════

function loadStocks(): Map<string, StockData> {
  const stocks = new Map<string, StockData>();
  const dir = path.join(process.cwd(), 'data', 'candles', MARKET);
  if (!fs.existsSync(dir)) { console.error('缺 candles 目錄：' + dir); return stocks; }
  process.stdout.write(`  讀取 ${MARKET} K線...`);
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const c: CandleWithIndicators[] = Array.isArray(raw) ? raw : raw.candles ?? raw;
      if (!c || c.length < 60) continue;
      const nm = (raw as { name?: string }).name ?? f.replace('.json', '');
      if (typeof nm === 'string' && nm.includes('ST')) continue;
      stocks.set(f.replace('.json', ''), { name: nm, candles: computeIndicators(c) });
    } catch { /* 略 */ }
  }
  console.log(` ${stocks.size} 支`);
  return stocks;
}

function buildTopNSet(
  allStocks: Map<string, StockData>,
  date: string,
  topN: number,
): Set<string> {
  const list: { symbol: string; avg: number }[] = [];
  for (const [symbol, sd] of allStocks) {
    const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
    if (idx < 1) continue;
    let total = 0, cnt = 0;
    for (let i = Math.max(0, idx - 20); i < idx; i++) {
      total += sd.candles[i].volume * sd.candles[i].close;
      cnt++;
    }
    list.push({ symbol, avg: cnt > 0 ? total / cnt : 0 });
  }
  list.sort((a, b) => b.avg - a.avg);
  return new Set(list.slice(0, topN).map(d => d.symbol));
}

function buildCandidate(
  symbol: string, name: string,
  candles: CandleWithIndicators[], idx: number,
  useMtf: boolean,
): Features | null {
  if (idx < 60 || idx + 3 >= candles.length) return null;

  const six = evaluateSixConditions(candles, idx, ZHU_OPTIMIZED.thresholds);
  if (!six.isCoreReady || six.totalScore < 5) return null;

  if (checkLongProhibitions(candles, idx).prohibited) return null;
  if (evaluateElimination(candles, idx).eliminated) return null;

  const c = candles[idx];
  const prev = candles[idx - 1];
  const changePercent = prev.close > 0 ? +((c.close - prev.close) / prev.close * 100).toFixed(2) : 0;
  const volumeRatio = prev.volume > 0 ? c.volume / prev.volume : 1;
  const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  const deviation = six.position.deviation ?? 0;
  const mom5 = idx >= 5 && candles[idx - 5].close > 0
    ? (c.close / candles[idx - 5].close - 1) * 100 : 0;
  const turnover = c.volume * c.close;

  let highWinRateScore = 0;
  try { highWinRateScore = evaluateHighWinRateEntry(candles, idx).score; } catch { /* 略 */ }

  let mtfScore = 0;
  try {
    mtfScore = evaluateMultiTimeframe(candles.slice(0, idx + 1), MTF_CFG).totalScore;
  } catch { /* 略 */ }

  // MTF 開 → 要求 mtfScore >= 3（PANEL_MTF_MIN_SCORE）
  if (useMtf && mtfScore < 3) return null;

  return {
    symbol, name, idx, candles, close: c.close,
    totalScore: six.totalScore, changePercent,
    volumeRatio, bodyPct, deviation, mom5, turnover,
    highWinRateScore, mtfScore,
  };
}

// ══════════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════════

interface PickRecord {
  factor: string;
  date: string;
  symbol: string;
  name: string;
  pickClose: number;
  d1Return: number | null;
  d2Return: number | null;
  d3Return: number | null;
}

function dateInRange(d: string, start: string, end: string): boolean {
  const dShort = d.slice(0, 10);
  return dShort >= start && dShort <= end;
}

function runPeriod(periodName: string, start: string, end: string, stocks: Map<string, StockData>,
                   cfg: { topN: number; useMtf: boolean; name: string }): void {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`期間：${periodName}  ${start} → ${end}   Config：${cfg.name}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const allDates = new Set<string>();
  for (const [, sd] of stocks) {
    for (const c of sd.candles) {
      const d = c.date?.slice(0, 10);
      if (d && dateInRange(d, start, end)) allDates.add(d);
    }
  }
  const tradingDays = [...allDates].sort();
  console.log(`  交易日：${tradingDays.length} 天`);

  const records: PickRecord[] = [];
  const factorNames = Object.keys(SORT_FACTORS);

  let doneDays = 0;
  for (const date of tradingDays) {
    const topNSet = buildTopNSet(stocks, date, cfg.topN);
    const candidates: Features[] = [];

    for (const symbol of topNSet) {
      const sd = stocks.get(symbol);
      if (!sd) continue;
      const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 0) continue;
      const f = buildCandidate(symbol, sd.name, sd.candles, idx, cfg.useMtf);
      if (f) candidates.push(f);
    }

    if (candidates.length === 0) {
      doneDays++;
      continue;
    }

    for (const factor of factorNames) {
      const sortFn = SORT_FACTORS[factor];
      const sorted = [...candidates].sort((a, b) => sortFn(b) - sortFn(a));
      const top = sorted[0];
      if (!top) continue;

      const { candles, idx, close, symbol, name } = top;
      const d1 = candles[idx + 1]?.close;
      const d2 = candles[idx + 2]?.close;
      const d3 = candles[idx + 3]?.close;
      const ret = (later: number | undefined) =>
        later != null && close > 0 ? (later - close) / close * 100 : null;

      records.push({
        factor, date, symbol, name, pickClose: close,
        d1Return: ret(d1), d2Return: ret(d2), d3Return: ret(d3),
      });
    }

    doneDays++;
    if (doneDays % 50 === 0) {
      process.stdout.write(`\r  進度：${doneDays}/${tradingDays.length}`);
    }
  }
  process.stdout.write(`\r  進度：${tradingDays.length}/${tradingDays.length}\n`);

  // 彙整
  const stats: Record<string, {
    n: number;
    d1Avg: number; d1Win: number;
    d2Avg: number; d2Win: number;
    d3Avg: number; d3Win: number;
  }> = {};

  for (const factor of factorNames) {
    const recs = records.filter(r => r.factor === factor);
    const d1 = recs.map(r => r.d1Return).filter((x): x is number => x != null);
    const d2 = recs.map(r => r.d2Return).filter((x): x is number => x != null);
    const d3 = recs.map(r => r.d3Return).filter((x): x is number => x != null);
    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const winRate = (arr: number[]) => arr.length ? arr.filter(x => x > 0).length / arr.length * 100 : 0;
    stats[factor] = {
      n: recs.length,
      d1Avg: avg(d1), d1Win: winRate(d1),
      d2Avg: avg(d2), d2Win: winRate(d2),
      d3Avg: avg(d3), d3Win: winRate(d3),
    };
  }

  // 輸出排行榜
  console.log(`\n  因子              n      d1 平均%  d1 勝率   d2 平均%  d2 勝率   d3 平均%  d3 勝率`);
  console.log(`  ────────────────────────────────────────────────────────────────────────`);
  const sorted = factorNames.sort((a, b) => stats[b].d3Avg - stats[a].d3Avg);
  for (const factor of sorted) {
    const s = stats[factor];
    console.log(
      `  ${factor.padEnd(15)}  ${String(s.n).padStart(4)}  ` +
      `${s.d1Avg.toFixed(2).padStart(8)}%  ${s.d1Win.toFixed(1).padStart(6)}%  ` +
      `${s.d2Avg.toFixed(2).padStart(8)}%  ${s.d2Win.toFixed(1).padStart(6)}%  ` +
      `${s.d3Avg.toFixed(2).padStart(8)}%  ${s.d3Win.toFixed(1).padStart(6)}%`
    );
  }
}

// ══════════════════════════════════════════════════════════════

(() => {
  const stocks = loadStocks();
  if (stocks.size === 0) {
    console.error('沒有股票資料，退出');
    return;
  }
  for (const cfg of CONFIGS) {
    console.log(`\n████████████████████████████████████████████████`);
    console.log(`███ Config：${cfg.name}`);
    console.log(`████████████████████████████████████████████████`);
    for (const p of PERIODS) {
      runPeriod(p.name, p.start, p.end, stocks, cfg);
    }
  }
  console.log('\n✅ 全部完成');
})();
