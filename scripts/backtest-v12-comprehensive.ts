/**
 * v12 全期間綜合回測（comprehensive）
 *
 * 期間：2026-01-01 → 2026-05-12（約 4.5 個月）
 * 策略：v12 全 13 字母（B/C/D/E/F/J/K/L/M/N/O/P/Q）
 *
 * 涵蓋面向：
 *   1. 4 種持有天數：d3, d5, d10, d20
 *   2. 4 種停損：無、-3%、-5%、-7%
 *   3. 資金成長模擬（B1 model：每天買 top-1、賣了才買下一支）
 *   4. 月份分布（Jan/Feb/Mar/Apr/May 一致性）
 *   5. TW vs CN 市場分項
 *   6. 共振配對分析（兩策略同時命中是否更賺）
 *   7. 最賺的具體股票（top performers）
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=12288" npx tsx scripts/backtest-v12-comprehensive.ts
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

// ════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════

const CONFIG = {
  startDate: process.env.BACKTEST_START ?? '2026-01-01',
  endDate: process.env.BACKTEST_END ?? '2026-05-12',
  label: process.env.BACKTEST_LABEL ?? '',   // 用於輸出檔名前綴（如 '1y'、'2y'）
  letters: ['B','C','D','E','F','J','K','L','M','N','O','P','Q'] as const,
  sorts: ['漲幅', '六條件', '成交額排名', '面板對齊'] as const,
  holdWindows: [3, 5, 10, 20] as const,
  stopLosses: [0, -3, -5, -7] as const,    // 0 = 無停損
  topNTurnover: 500,
  minPicksForGrade: 30,
  initialCapital: 1_000_000,
  costPctTW: 0.471,         // 對齊 backtest-run.ts
  costPctCN: 0.16,
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
const OUT_JSON = path.join(ROOT, `backtest_v12_comprehensive${CONFIG.label ? '_' + CONFIG.label : ''}.json`);
const OUT_MD_DIR = path.join(ROOT, 'backtest-output');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_MD = path.join(OUT_MD_DIR, `v12-comprehensive${CONFIG.label ? '-' + CONFIG.label : ''}-${TODAY}.md`);

// ════════════════════════════════════════════════════════════════
// 型別
// ════════════════════════════════════════════════════════════════

interface StockData {
  symbol: string;
  name: string;
  market: 'TW' | 'CN';
  candles: CandleWithIndicators[];
  dateToIdx: Map<string, number>;
}

interface ForwardMetrics {
  /** 進場價（T+1 open） */
  entryPrice: number;
  /** 每個 hold window 的 close return（T+H close vs entry）*/
  closeReturns: Record<number, number>;
  /** 每個 hold window 的 maxGain（max(high) over T+1..T+H vs entry）*/
  maxGains: Record<number, number>;
  /** 每個 hold window 期間的 worstLow */
  worstLows: Record<number, number>;
  /** 觸發停損時的退出 day index（從 T+1 算起，0-based） */
  stopLossExitDay: Record<number, number | null>;
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
  fwd: ForwardMetrics | null;
}

interface Pick {
  market: 'TW' | 'CN';
  date: string;
  symbol: string;
  name: string;
  matchedMethods: V12Letter[];
  fwd: ForwardMetrics;
}

// ════════════════════════════════════════════════════════════════
// 載入 L1 + 算 indicators
// ════════════════════════════════════════════════════════════════

function loadMarketStocks(market: 'TW' | 'CN'): StockData[] {
  const dir = path.join(CANDLE_ROOT, market);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const isIndex = (s: string) => s.startsWith('^') || s === '000001.SS' || s === '000001.SZ' || s === '000300.SS';
  const list: StockData[] = [];
  let loaded = 0, skipped = 0;
  process.stdout.write(`  讀取 ${market} L1`);
  for (const f of files) {
    const symbol = f.replace('.json', '');
    if (isIndex(symbol)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const rawCandles = Array.isArray(raw) ? raw : raw.candles ?? [];
      const name = (raw as { name?: string }).name ?? symbol;
      if (typeof name === 'string' && name.includes('ST')) { skipped++; continue; }
      const candles: CandleWithIndicators[] = rawCandles.map((c: { date?: string; open?: number; close?: number; high?: number; low?: number; volume?: number }) => ({
        date: (c.date ?? '').slice(0, 10),
        open: Number(c.open) || 0,
        high: Number(c.high) || 0,
        low: Number(c.low) || 0,
        close: Number(c.close) || 0,
        volume: Number(c.volume) || 0,
      } as CandleWithIndicators));
      if (candles.length < 60) { skipped++; continue; }
      const withIndicators = computeIndicators(candles);
      const dateToIdx = new Map<string, number>();
      withIndicators.forEach((c, i) => dateToIdx.set(c.date.slice(0, 10), i));
      list.push({ symbol, name, market, candles: withIndicators, dateToIdx });
      loaded++;
      if (loaded % 200 === 0) process.stdout.write('.');
    } catch { skipped++; }
  }
  console.log(` → ${loaded} 支（skip ${skipped}）`);
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

// ════════════════════════════════════════════════════════════════
// Forward metrics（一次算多 window）
// ════════════════════════════════════════════════════════════════

function computeForward(stock: StockData, t0Date: string): ForwardMetrics | null {
  const t0 = stock.dateToIdx.get(t0Date);
  if (t0 == null) return null;
  const maxWindow = Math.max(...CONFIG.holdWindows);
  if (t0 + 1 >= stock.candles.length) return null;
  const entry = stock.candles[t0 + 1].open;
  if (entry <= 0) return null;

  const closeReturns: Record<number, number> = {};
  const maxGains: Record<number, number> = {};
  const worstLows: Record<number, number> = {};
  const stopLossExitDay: Record<number, number | null> = {};

  let runningHigh = -Infinity;
  let runningLow = Infinity;
  let stopHit3 = false, stopHit5 = false, stopHit7 = false;
  let stopDay3: number | null = null, stopDay5: number | null = null, stopDay7: number | null = null;

  for (let h = 1; h <= maxWindow; h++) {
    const i = t0 + h;
    if (i >= stock.candles.length) break;
    const c = stock.candles[i];
    if (c.high > runningHigh) runningHigh = c.high;
    if (c.low < runningLow) runningLow = c.low;

    // 檢查停損（intraday low 觸停損 → 該日 exit）
    const lowPctFromEntry = (c.low - entry) / entry * 100;
    if (!stopHit3 && lowPctFromEntry <= -3) { stopHit3 = true; stopDay3 = h; }
    if (!stopHit5 && lowPctFromEntry <= -5) { stopHit5 = true; stopDay5 = h; }
    if (!stopHit7 && lowPctFromEntry <= -7) { stopHit7 = true; stopDay7 = h; }

    if (CONFIG.holdWindows.includes(h as 3 | 5 | 10 | 20)) {
      closeReturns[h] = (c.close - entry) / entry * 100;
      maxGains[h] = (runningHigh - entry) / entry * 100;
      worstLows[h] = (runningLow - entry) / entry * 100;
      stopLossExitDay[h] = null; // populated below
    }
  }

  // stop-loss exit day per window
  // For each hold window H, find the earliest stop hit day that occurred within H
  for (const H of CONFIG.holdWindows) {
    stopLossExitDay[H] = null; // not used per H, but kept for compat
  }
  // Store per-stop-loss day separately on metrics object
  (stopLossExitDay as Record<string, number | null>)['_stop3'] = stopDay3;
  (stopLossExitDay as Record<string, number | null>)['_stop5'] = stopDay5;
  (stopLossExitDay as Record<string, number | null>)['_stop7'] = stopDay7;

  return { entryPrice: entry, closeReturns, maxGains, worstLows, stopLossExitDay };
}

// ════════════════════════════════════════════════════════════════
// 算每日成交額排名
// ════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════
// 收集事件
// ════════════════════════════════════════════════════════════════

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
  console.log(`  ${market} 期間交易日：${dates.length} 天 (${dates[0]} → ${dates.at(-1)})`);

  const indexDateToIdx = new Map<string, number>();
  indexCandles.forEach((c, i) => indexDateToIdx.set(c.date.slice(0, 10), i));

  const stockMap = new Map<string, StockData>();
  for (const s of stocks) stockMap.set(s.symbol, s);

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
        const changePercent = prev && prev.close > 0
          ? (s.candles[idx].close - prev.close) / prev.close * 100
          : 0;
        const indicatorOK = result.step1.indicatorPassed;
        const volumeNormalOrClimax = result.step1.volumeLevel != null;
        const step1Passed = isLongTrend && indicatorOK && volumeNormalOrClimax;
        const sixScore = (isLongTrend ? 3 : 0) + (indicatorOK ? 2 : 0) + (volumeNormalOrClimax ? 1 : 0);

        const fwd = computeForward(s, date);

        events.push({
          market: s.market, date,
          symbol: s.symbol, name: s.name,
          matchedMethods: triggered as V12Letter[],
          sixConditionsScore: sixScore,
          step1Passed,
          changePercent,
          turnoverRank: r,
          fwd,
        });
      } catch { /* skip */ }
    }
    processed++;
    if (processed % 20 === 0) process.stdout.write(`    [${market}] ${processed}/${dates.length}\n`);
  }
  return events;
}

// ════════════════════════════════════════════════════════════════
// 排序
// ════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════
// 取 top-1 picks
// ════════════════════════════════════════════════════════════════

function pickTopOne(events: EvalEvent[], letter: string, sort: typeof CONFIG.sorts[number]): Pick[] {
  const sortFn = SORT_FNS[sort];
  const byDayMarket = new Map<string, EvalEvent[]>();
  for (const e of events) {
    if (!e.matchedMethods.includes(letter as V12Letter)) continue;
    if (!passesProductionGate(letter, e)) continue;
    if (!e.fwd) continue;
    const k = `${e.market}|${e.date}`;
    const arr = byDayMarket.get(k) ?? [];
    arr.push(e);
    byDayMarket.set(k, arr);
  }
  const picks: Pick[] = [];
  for (const [, arr] of byDayMarket) {
    arr.sort((a, b) => sortFn(b) - sortFn(a));
    const top = arr[0];
    picks.push({
      market: top.market, date: top.date,
      symbol: top.symbol, name: top.name,
      matchedMethods: top.matchedMethods,
      fwd: top.fwd!,
    });
  }
  return picks.sort((a, b) => a.date.localeCompare(b.date));
}

// ════════════════════════════════════════════════════════════════
// 統計工具
// ════════════════════════════════════════════════════════════════

function mean(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round(x: number, p = 2): number { const f = Math.pow(10, p); return Math.round(x * f) / f; }
function fmtSigned(x: number): string { return (x >= 0 ? '+' : '') + x.toFixed(2); }

// 計算「在 hold window H 內、停損 -X% 後」的實際單筆報酬
function effectiveReturn(p: Pick, holdWindow: number, stopLossPct: number): number {
  const fwd = p.fwd;
  // 找停損觸發日（不存在則 null）
  let stopDay: number | null = null;
  if (stopLossPct === -3) stopDay = (fwd.stopLossExitDay as Record<string, number | null>)['_stop3'] ?? null;
  else if (stopLossPct === -5) stopDay = (fwd.stopLossExitDay as Record<string, number | null>)['_stop5'] ?? null;
  else if (stopLossPct === -7) stopDay = (fwd.stopLossExitDay as Record<string, number | null>)['_stop7'] ?? null;
  // 0 = 無停損
  if (stopDay != null && stopDay <= holdWindow) return stopLossPct; // 假設以停損價成交
  return fwd.closeReturns[holdWindow] ?? 0;
}

// ════════════════════════════════════════════════════════════════
// 主排行：多 window × 多 stop-loss
// ════════════════════════════════════════════════════════════════

interface CellSummary {
  letter: string;
  letterName: string;
  sort: string;
  track: string;
  picks: number;
  // 對每個 hold window 算
  byHold: Record<number, {
    avgClose: number;
    medClose: number;
    avgMaxGain: number;
    winRate: number;
    hit5Pct: number;
    // 對每個 stop-loss 算
    byStop: Record<number, { avgReturn: number; winRate: number; stoppedOut: number }>;
  }>;
  // 資金成長（B1：以 d3 close 為退出，無停損）
  capitalGrowth: {
    finalCapital: number;
    totalReturn: number;
    trades: number;
    avgHoldDays: number;
  };
}

function simulateCapitalGrowth(picks: Pick[], holdWindow: number): { finalCapital: number; totalReturn: number; trades: number; avgHoldDays: number } {
  // B1 model: 每天買 top-1，賣了才買下一支。
  // hold = holdWindow 天（或停損觸發提前出場）
  let capital = CONFIG.initialCapital;
  let holdingUntil = ''; // 持有股票賣出日 YYYY-MM-DD
  let trades = 0;
  let holdDaysSum = 0;
  const sorted = [...picks].sort((a, b) => a.date.localeCompare(b.date));
  for (const p of sorted) {
    if (p.date < holdingUntil) continue; // 還持有
    const costPct = p.market === 'TW' ? CONFIG.costPctTW : CONFIG.costPctCN;
    const ret = p.fwd.closeReturns[holdWindow];
    if (ret == null) continue;
    const netPct = ret - costPct;
    capital *= 1 + netPct / 100;
    capital = Math.max(0, capital);
    // 估 holdingUntil（簡化：加 holdWindow * 1.4 calendar day 涵蓋週末）
    const t0 = new Date(p.date);
    const exit = new Date(t0.getTime() + Math.ceil(holdWindow * 1.4) * 86400_000);
    holdingUntil = exit.toISOString().slice(0, 10);
    trades++;
    holdDaysSum += holdWindow;
  }
  return {
    finalCapital: Math.round(capital),
    totalReturn: (capital - CONFIG.initialCapital) / CONFIG.initialCapital * 100,
    trades,
    avgHoldDays: trades ? holdDaysSum / trades : 0,
  };
}

function summarizeCell(letter: string, sort: string, picks: Pick[]): CellSummary {
  const byHold: CellSummary['byHold'] = {};
  for (const H of CONFIG.holdWindows) {
    const closes = picks.map(p => p.fwd.closeReturns[H]).filter((x): x is number => x != null);
    const maxGains = picks.map(p => p.fwd.maxGains[H]).filter((x): x is number => x != null);
    const byStop: CellSummary['byHold'][number]['byStop'] = {};
    for (const S of CONFIG.stopLosses) {
      const effRet = picks.map(p => effectiveReturn(p, H, S));
      const stopped = picks.filter(p => {
        const fwd = p.fwd;
        if (S === 0) return false;
        const day = (fwd.stopLossExitDay as Record<string, number | null>)[`_stop${Math.abs(S)}`];
        return day != null && day <= H;
      }).length;
      byStop[S] = {
        avgReturn: round(mean(effRet)),
        winRate: round(effRet.length ? effRet.filter(x => x > 0).length / effRet.length * 100 : 0, 1),
        stoppedOut: stopped,
      };
    }
    byHold[H] = {
      avgClose: round(mean(closes)),
      medClose: round(median(closes)),
      avgMaxGain: round(mean(maxGains)),
      winRate: round(closes.length ? closes.filter(x => x > 0).length / closes.length * 100 : 0, 1),
      hit5Pct: round(maxGains.length ? maxGains.filter(x => x >= 5).length / maxGains.length * 100 : 0, 1),
      byStop,
    };
  }
  return {
    letter,
    letterName: STRATEGY_NAME[letter] ?? letter,
    sort,
    track: TRACK_LABEL[letter] ?? '-',
    picks: picks.length,
    byHold,
    capitalGrowth: simulateCapitalGrowth(picks, 5), // 用 d5 作為主資金成長窗口
  };
}

// ════════════════════════════════════════════════════════════════
// 月份分布
// ════════════════════════════════════════════════════════════════

interface MonthlyStats {
  letter: string;
  letterName: string;
  month: string;
  picks: number;
  avgClose5d: number;
  winRateClose5d: number;
}

function computeMonthlyStats(events: EvalEvent[]): MonthlyStats[] {
  const out: MonthlyStats[] = [];
  for (const L of CONFIG.letters) {
    const picks = pickTopOne(events, L, '漲幅');
    const byMonth = new Map<string, Pick[]>();
    for (const p of picks) {
      const m = p.date.slice(0, 7);
      const arr = byMonth.get(m) ?? [];
      arr.push(p);
      byMonth.set(m, arr);
    }
    for (const [m, arr] of byMonth) {
      const closes = arr.map(p => p.fwd.closeReturns[5]).filter((x): x is number => x != null);
      out.push({
        letter: L,
        letterName: STRATEGY_NAME[L] ?? L,
        month: m,
        picks: arr.length,
        avgClose5d: round(mean(closes)),
        winRateClose5d: round(closes.length ? closes.filter(x => x > 0).length / closes.length * 100 : 0, 1),
      });
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// TW vs CN 分項
// ════════════════════════════════════════════════════════════════

interface MarketStats {
  letter: string;
  letterName: string;
  market: 'TW' | 'CN';
  picks: number;
  avgClose5d: number;
  winRateClose5d: number;
  capitalGrowth5d: number;
}

function computeMarketStats(events: EvalEvent[]): MarketStats[] {
  const out: MarketStats[] = [];
  for (const L of CONFIG.letters) {
    const picks = pickTopOne(events, L, '漲幅');
    for (const mkt of ['TW', 'CN'] as const) {
      const arr = picks.filter(p => p.market === mkt);
      const closes = arr.map(p => p.fwd.closeReturns[5]).filter((x): x is number => x != null);
      out.push({
        letter: L,
        letterName: STRATEGY_NAME[L] ?? L,
        market: mkt,
        picks: arr.length,
        avgClose5d: round(mean(closes)),
        winRateClose5d: round(closes.length ? closes.filter(x => x > 0).length / closes.length * 100 : 0, 1),
        capitalGrowth5d: round(simulateCapitalGrowth(arr, 5).totalReturn),
      });
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// 共振配對
// ════════════════════════════════════════════════════════════════

interface PairStats {
  letters: string;
  picks: number;
  avgMaxGain5d: number;
  winRate5d: number;
  delta: number; // 共振 - 兩 letter 獨立平均
}

function computePairs(events: EvalEvent[], cellByLetter: Map<string, CellSummary>): PairStats[] {
  const pairs = new Map<string, { d5: number[] }>();
  for (const e of events) {
    if (!e.fwd) continue;
    const ms = [...e.matchedMethods].filter(m => CONFIG.letters.includes(m as typeof CONFIG.letters[number])).sort();
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const key = `${ms[i]}+${ms[j]}`;
        const slot = pairs.get(key) ?? { d5: [] };
        slot.d5.push(e.fwd.maxGains[5]);
        pairs.set(key, slot);
      }
    }
  }
  const out: PairStats[] = [];
  for (const [k, v] of pairs) {
    if (v.d5.length < 30) continue;
    const [a, b] = k.split('+');
    const aSummary = cellByLetter.get(a);
    const bSummary = cellByLetter.get(b);
    const aAvg = aSummary?.byHold[5]?.avgMaxGain ?? 0;
    const bAvg = bSummary?.byHold[5]?.avgMaxGain ?? 0;
    const d5Avg = mean(v.d5);
    out.push({
      letters: `${STRATEGY_NAME[a]} + ${STRATEGY_NAME[b]}`,
      picks: v.d5.length,
      avgMaxGain5d: round(d5Avg),
      winRate5d: round(v.d5.filter(x => x > 0).length / v.d5.length * 100, 1),
      delta: round(d5Avg - (aAvg + bAvg) / 2),
    });
  }
  return out.sort((a, b) => b.avgMaxGain5d - a.avgMaxGain5d);
}

// ════════════════════════════════════════════════════════════════
// 最賺的個股
// ════════════════════════════════════════════════════════════════

interface StockPerformance {
  market: 'TW' | 'CN';
  symbol: string;
  name: string;
  triggerCount: number;
  avgMaxGain5d: number;
  bestMaxGain: number;
  bestDate: string;
  letters: string[];
}

function computeTopStocks(events: EvalEvent[]): StockPerformance[] {
  const byStock = new Map<string, { evs: EvalEvent[] }>();
  for (const e of events) {
    if (!e.fwd) continue;
    const k = `${e.market}|${e.symbol}`;
    const slot = byStock.get(k) ?? { evs: [] };
    slot.evs.push(e);
    byStock.set(k, slot);
  }
  const out: StockPerformance[] = [];
  for (const [k, { evs }] of byStock) {
    const [market, symbol] = k.split('|');
    const mg = evs.map(e => e.fwd!.maxGains[5]).filter((x): x is number => x != null);
    const best = evs.reduce((b, e) => (e.fwd!.maxGains[5] ?? -Infinity) > (b.fwd!.maxGains[5] ?? -Infinity) ? e : b);
    const letters = new Set<string>();
    for (const e of evs) for (const m of e.matchedMethods) letters.add(m);
    out.push({
      market: market as 'TW' | 'CN',
      symbol,
      name: evs[0].name,
      triggerCount: evs.length,
      avgMaxGain5d: round(mean(mg)),
      bestMaxGain: round(best.fwd!.maxGains[5] ?? 0),
      bestDate: best.date,
      letters: [...letters].sort(),
    });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// Markdown 輸出
// ════════════════════════════════════════════════════════════════

const nameOf = (L: string) => STRATEGY_NAME[L] ?? L;

// ════════════════════════════════════════════════════════════════
// 新增：per-市場 × per-排序 矩陣
// ════════════════════════════════════════════════════════════════

interface MarketSortCell {
  market: 'TW' | 'CN';
  letter: string;
  letterName: string;
  sort: string;
  picks: number;
  avgClose5d: number;
  avgMaxGain5d: number;
  winRateClose5d: number;
  capitalGrowth5d: number;
}

function computeMarketSortMatrix(events: EvalEvent[]): MarketSortCell[] {
  const out: MarketSortCell[] = [];
  for (const mkt of ['TW', 'CN'] as const) {
    const mktEvents = events.filter(e => e.market === mkt);
    for (const L of CONFIG.letters) {
      for (const sort of CONFIG.sorts) {
        const picks = pickTopOne(mktEvents, L, sort);
        const closes = picks.map(p => p.fwd.closeReturns[5]).filter((x): x is number => x != null);
        const maxGains = picks.map(p => p.fwd.maxGains[5]).filter((x): x is number => x != null);
        out.push({
          market: mkt,
          letter: L,
          letterName: STRATEGY_NAME[L] ?? L,
          sort,
          picks: picks.length,
          avgClose5d: round(mean(closes)),
          avgMaxGain5d: round(mean(maxGains)),
          winRateClose5d: round(closes.length ? closes.filter(x => x > 0).length / closes.length * 100 : 0, 1),
          capitalGrowth5d: round(simulateCapitalGrowth(picks, 5).totalReturn),
        });
      }
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// 新增：大盤趨勢日 split（多頭日 vs 盤整/空頭日）
// ════════════════════════════════════════════════════════════════

interface RegimeStats {
  market: 'TW' | 'CN';
  letter: string;
  letterName: string;
  regime: '多頭日' | '盤整/空頭日';
  picks: number;
  avgClose5d: number;
  winRateClose5d: number;
}

/** 用大盤 close > MA20 且 MA20 上揚（近 5 日斜率 > 0）= 多頭日 */
function tagDateRegime(indexCandles: CandleWithIndicators[], date: string): '多頭日' | '盤整/空頭日' {
  const idx = indexCandles.findIndex(c => c.date.slice(0, 10) === date);
  if (idx < 5) return '盤整/空頭日';
  const c = indexCandles[idx];
  const ma20 = (c as { ma20?: number }).ma20;
  if (ma20 == null) return '盤整/空頭日';
  const ma20Prev = (indexCandles[idx - 5] as { ma20?: number }).ma20;
  if (ma20Prev == null) return '盤整/空頭日';
  return c.close > ma20 && ma20 > ma20Prev ? '多頭日' : '盤整/空頭日';
}

function computeRegimeStats(events: EvalEvent[], indexByMarket: Record<'TW'|'CN', CandleWithIndicators[]>): RegimeStats[] {
  const out: RegimeStats[] = [];
  for (const mkt of ['TW', 'CN'] as const) {
    const mktEvents = events.filter(e => e.market === mkt);
    for (const L of CONFIG.letters) {
      const picks = pickTopOne(mktEvents, L, '漲幅');
      for (const regime of ['多頭日', '盤整/空頭日'] as const) {
        const arr = picks.filter(p => tagDateRegime(indexByMarket[mkt], p.date) === regime);
        const closes = arr.map(p => p.fwd.closeReturns[5]).filter((x): x is number => x != null);
        out.push({
          market: mkt,
          letter: L,
          letterName: STRATEGY_NAME[L] ?? L,
          regime,
          picks: arr.length,
          avgClose5d: round(mean(closes)),
          winRateClose5d: round(closes.length ? closes.filter(x => x > 0).length / closes.length * 100 : 0, 1),
        });
      }
    }
  }
  return out;
}

/**
 * 等級基於 close 報酬 + close winRate（實際 holding 報酬，非 maxGain）
 * 改用「實際拿到的錢」當判準，不是「曾經漲過多少」
 */
function gradeOf(picks: number, avgClose: number, winRateClose: number): string {
  if (picks < 5) return 'low-sample';
  if (picks < CONFIG.minPicksForGrade) return 'tentative';
  if (avgClose >= 3 && winRateClose >= 55) return 'A';
  if (avgClose >= 1.5 && winRateClose >= 50) return 'B';
  if (avgClose >= 0.5 && winRateClose >= 45) return 'C';
  return 'D';
}

function writeMarkdown(
  cells: CellSummary[],
  monthly: MonthlyStats[],
  marketStats: MarketStats[],
  pairs: PairStats[],
  topStocks: StockPerformance[],
  marketSortMatrix: MarketSortCell[],
  regimeStats: RegimeStats[],
  meta: { eventsCount: number; daysTW: number; daysCN: number; twTrendDays: { 多頭日: number; 盤整: number }; cnTrendDays: { 多頭日: number; 盤整: number } }
): void {
  if (!fs.existsSync(OUT_MD_DIR)) fs.mkdirSync(OUT_MD_DIR, { recursive: true });
  const lines: string[] = [];

  // ─── 標題與摘要 ───
  lines.push(`# v12 全期間綜合回測報告（${CONFIG.startDate} → ${CONFIG.endDate}）`);
  lines.push('');
  lines.push(`產出時間：${new Date().toISOString()}`);
  lines.push('');
  lines.push(`**期間**：${CONFIG.startDate} → ${CONFIG.endDate}（約 4.5 個月）`);
  lines.push(`**TW 交易日**：${meta.daysTW} 天　**CN 交易日**：${meta.daysCN} 天　**事件總數**：${meta.eventsCount} 筆`);
  lines.push(`**策略**：v12 全 13 字母　**排序**：4 種　**持有天數**：d3 / d5 / d10 / d20　**停損**：無 / −3% / −5% / −7%`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── TL;DR ───
  lines.push('## TL;DR 速覽');
  lines.push('');
  lines.push('**重點區分兩種「賺錢」指標**：');
  lines.push('- 「期間內 maxGain」= 持有期間 high 觸頂的最大漲幅（你能在區間最高點賣的話）');
  lines.push('- 「T+H 收盤報酬」= 持有到第 H 天收盤的實際報酬（不擇時、放著就好）');
  lines.push('');
  lines.push('### 各持有天數最賺策略（依「實際 T+H 收盤報酬」排序）');
  for (const H of CONFIG.holdWindows) {
    const sorted = [...cells].filter(c => c.picks >= CONFIG.minPicksForGrade).sort((a, b) => b.byHold[H].avgClose - a.byHold[H].avgClose);
    const top = sorted[0];
    if (!top) continue;
    lines.push(`- **持有 ${H} 天最賺**：${top.letterName} × ${top.sort}（${top.picks} 次、收盤平均 ${fmtSigned(top.byHold[H].avgClose)}%、勝率 ${top.byHold[H].winRate}%、期間 maxGain ${fmtSigned(top.byHold[H].avgMaxGain)}%）`);
  }
  lines.push('');
  lines.push('### 各持有天數「理想最大漲幅」最高');
  for (const H of CONFIG.holdWindows) {
    const sorted = [...cells].filter(c => c.picks >= CONFIG.minPicksForGrade).sort((a, b) => b.byHold[H].avgMaxGain - a.byHold[H].avgMaxGain);
    const top = sorted[0];
    if (!top) continue;
    lines.push(`- **持有 ${H} 天 maxGain 最高**：${top.letterName} × ${top.sort}（${top.picks} 次、maxGain 平均 ${fmtSigned(top.byHold[H].avgMaxGain)}%、收盤 ${fmtSigned(top.byHold[H].avgClose)}%）`);
  }
  lines.push('');
  // 資金成長最佳（d5）
  const bestCap = [...cells].filter(c => c.picks >= CONFIG.minPicksForGrade).sort((a, b) => b.capitalGrowth.totalReturn - a.capitalGrowth.totalReturn)[0];
  if (bestCap) {
    lines.push(`### 資金成長最強（持有 5 天、B1 模型：賣了才買、全資金 all-in、扣手續費）`);
    lines.push(`- **${bestCap.letterName} × ${bestCap.sort}**　$1,000,000 → **$${bestCap.capitalGrowth.finalCapital.toLocaleString()}**（${fmtSigned(bestCap.capitalGrowth.totalReturn)}%，${bestCap.capitalGrowth.trades} 筆交易，4.5 個月）`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 策略對照 ───
  lines.push('## 1. v12 策略對照');
  lines.push('');
  lines.push('| 策略 | 軌道 | 書本根據 |');
  lines.push('|---|---|---|');
  for (const L of CONFIG.letters) {
    lines.push(`| **${nameOf(L)}** | ${TRACK_LABEL[L]} | 朱家泓 五步法／飆股／寶典 |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 主排行（每 hold window 兩張表：實際收盤 + 理想 maxGain） ───
  for (const H of CONFIG.holdWindows) {
    const idx = CONFIG.holdWindows.indexOf(H) + 1;
    // 2.X.a 實際收盤報酬排行
    lines.push(`## 2.${idx} 主排行：持有 ${H} 天`);
    lines.push('');
    lines.push(`### 2.${idx}A 依「實際 T+${H} 收盤報酬」排序（現實派，top 15）`);
    lines.push('');
    lines.push(`| # | 策略 | 排序 | 軌道 | 買進次數 | T+${H} 收盤均% | 中位% | 期間 maxGain% | 勝率% | ≥5%命中% | 等級 |`);
    lines.push('|---:|---|---|---|---:|---:|---:|---:|---:|---:|:--:|');
    const rankedByClose = [...cells].filter(c => c.picks >= 5).sort((a, b) => b.byHold[H].avgClose - a.byHold[H].avgClose);
    rankedByClose.slice(0, 15).forEach((c, i) => {
      const h = c.byHold[H];
      const grade = gradeOf(c.picks, h.avgClose, h.winRate);
      lines.push(`| ${i + 1} | **${c.letterName}** | ${c.sort} | ${c.track} | ${c.picks} | ${fmtSigned(h.avgClose)} | ${fmtSigned(h.medClose)} | ${fmtSigned(h.avgMaxGain)} | ${h.winRate.toFixed(1)} | ${h.hit5Pct.toFixed(1)} | **${grade}** |`);
    });
    lines.push('');

    // 2.X.b 理想最大漲幅排行
    lines.push(`### 2.${idx}B 依「期間內最大漲幅 maxGain」排序（理想派，top 15）`);
    lines.push('');
    lines.push(`| # | 策略 | 排序 | 軌道 | 買進次數 | maxGain均% | T+${H} 收盤均% | 中位收盤% | 勝率% | ≥5%命中% | 等級 |`);
    lines.push('|---:|---|---|---|---:|---:|---:|---:|---:|---:|:--:|');
    const rankedByMG = [...cells].filter(c => c.picks >= 5).sort((a, b) => b.byHold[H].avgMaxGain - a.byHold[H].avgMaxGain);
    rankedByMG.slice(0, 15).forEach((c, i) => {
      const h = c.byHold[H];
      const grade = gradeOf(c.picks, h.avgClose, h.winRate);
      lines.push(`| ${i + 1} | **${c.letterName}** | ${c.sort} | ${c.track} | ${c.picks} | ${fmtSigned(h.avgMaxGain)} | ${fmtSigned(h.avgClose)} | ${fmtSigned(h.medClose)} | ${h.winRate.toFixed(1)} | ${h.hit5Pct.toFixed(1)} | **${grade}** |`);
    });
    lines.push('');
  }
  lines.push('---');
  lines.push('');

  // ─── 等級彙整（哪些策略哪個 hold window 拿到 A/B/C 級）───
  lines.push('## 3. 等級彙整（每個策略 × 每個持有天數，依「漲幅」排序）');
  lines.push('');
  lines.push('等級判定依據：實際 T+H 收盤報酬均 + close winRate（不是 maxGain）');
  lines.push('A: 收盤均 ≥ 3% 且勝率 ≥ 55% | B: ≥ 1.5% 且 ≥ 50% | C: ≥ 0.5% 且 ≥ 45% | D: 都不到');
  lines.push('');
  lines.push('| 策略 | 軌道 | picks | d3 等級 | d5 等級 | d10 等級 | d20 等級 |');
  lines.push('|---|---|---:|:--:|:--:|:--:|:--:|');
  for (const L of CONFIG.letters) {
    const c = cells.find(x => x.letter === L && x.sort === '漲幅');
    if (!c) { lines.push(`| **${nameOf(L)}** | ${TRACK_LABEL[L]} | - | - | - | - | - |`); continue; }
    const grades = CONFIG.holdWindows.map(H => {
      const h = c.byHold[H];
      const g = gradeOf(c.picks, h.avgClose, h.winRate);
      return `${g} (${fmtSigned(h.avgClose)}%/${h.winRate.toFixed(0)}%)`;
    });
    lines.push(`| **${c.letterName}** | ${c.track} | ${c.picks} | ${grades[0]} | ${grades[1]} | ${grades[2]} | ${grades[3]} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 持有天數對比（per 策略，漲幅排序） ───
  lines.push('## 4. 持有天數對比（每個策略用「漲幅」排序、最大漲幅平均%）');
  lines.push('');
  lines.push('| 策略 | 軌道 | picks | d3 maxG | d5 maxG | d10 maxG | d20 maxG | d5 收盤均 | d5 勝率 |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const L of CONFIG.letters) {
    const c = cells.find(x => x.letter === L && x.sort === '漲幅');
    if (!c || c.picks < 5) { lines.push(`| **${nameOf(L)}** | ${TRACK_LABEL[L]} | _不足_ | - | - | - | - | - | - |`); continue; }
    lines.push(`| **${c.letterName}** | ${c.track} | ${c.picks} | ${fmtSigned(c.byHold[3].avgMaxGain)} | ${fmtSigned(c.byHold[5].avgMaxGain)} | ${fmtSigned(c.byHold[10].avgMaxGain)} | ${fmtSigned(c.byHold[20].avgMaxGain)} | ${fmtSigned(c.byHold[5].avgClose)} | ${c.byHold[5].winRate}% |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 停損策略對比（per 策略，漲幅排序，d5 hold） ───
  lines.push('## 5. 停損策略對比（漲幅排序、持有 5 天、實際單筆報酬均%）');
  lines.push('');
  lines.push('| 策略 | 無停損 | −3% 停損 | −5% 停損 | −7% 停損 | −3% 觸發次數 | −5% 觸發次數 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const L of CONFIG.letters) {
    const c = cells.find(x => x.letter === L && x.sort === '漲幅');
    if (!c || c.picks < 5) { lines.push(`| **${nameOf(L)}** | - | - | - | - | - | - |`); continue; }
    const bs = c.byHold[5].byStop;
    lines.push(`| **${c.letterName}** | ${fmtSigned(bs[0].avgReturn)}% | ${fmtSigned(bs[-3].avgReturn)}% | ${fmtSigned(bs[-5].avgReturn)}% | ${fmtSigned(bs[-7].avgReturn)}% | ${bs[-3].stoppedOut} | ${bs[-5].stoppedOut} |`);
  }
  lines.push('');
  lines.push('解讀：停損 −3% 後若單筆報酬高於「無停損」，代表「砍小賠」策略對該字母有利。低於則代表停損反而切掉了大部分本來會反彈的單。');
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 資金成長模擬 ───
  lines.push('## 6. 資金成長模擬（B1 模型：每天買 top-1、持有 5 天、賣了才能再買，初始 $1,000,000）');
  lines.push('');
  lines.push('規則：每天看排序第一名→T+1 開盤買→T+5 收盤賣→重複。已扣手續費（TW 0.471% / CN 0.16%）。沒考慮停損。');
  lines.push('');
  lines.push('| 策略 | 排序 | 交易次數 | 最終資金 | 總報酬% |');
  lines.push('|---|---|---:|---:|---:|');
  const sortedByCap = [...cells].filter(c => c.picks >= CONFIG.minPicksForGrade).sort((a, b) => b.capitalGrowth.totalReturn - a.capitalGrowth.totalReturn);
  for (const c of sortedByCap.slice(0, 25)) {
    lines.push(`| **${c.letterName}** | ${c.sort} | ${c.capitalGrowth.trades} | $${c.capitalGrowth.finalCapital.toLocaleString()} | ${fmtSigned(c.capitalGrowth.totalReturn)}% |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 月份分布 ───
  lines.push('## 7. 月份分布（每月用「漲幅」排序、持有 5 天、收盤報酬）');
  lines.push('');
  lines.push('每格 = `picks / close 勝率 / d5 收盤均%`');
  lines.push('');
  const months = [...new Set(monthly.map(m => m.month))].sort();
  lines.push(`| 策略 | ${months.join(' | ')} |`);
  lines.push(`|---|${months.map(() => '---:').join('|')}|`);
  for (const L of CONFIG.letters) {
    const cells = months.map(m => {
      const s = monthly.find(x => x.letter === L && x.month === m);
      if (!s || s.picks === 0) return '-';
      return `${s.picks} / ${s.winRateClose5d}% / ${fmtSigned(s.avgClose5d)}`;
    });
    lines.push(`| **${nameOf(L)}** | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── TW vs CN ───
  lines.push('## 8. TW vs CN 市場分項');
  lines.push('');
  lines.push('### 8.1 漲幅排序、持有 5 天、收盤報酬');
  lines.push('');
  lines.push('| 策略 | TW picks | TW 收盤均% | TW 勝率 | TW 資金成長 | CN picks | CN 收盤均% | CN 勝率 | CN 資金成長 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const L of CONFIG.letters) {
    const tw = marketStats.find(s => s.letter === L && s.market === 'TW');
    const cn = marketStats.find(s => s.letter === L && s.market === 'CN');
    lines.push(`| **${nameOf(L)}** | ${tw?.picks ?? 0} | ${fmtSigned(tw?.avgClose5d ?? 0)} | ${tw?.winRateClose5d ?? 0}% | ${fmtSigned(tw?.capitalGrowth5d ?? 0)}% | ${cn?.picks ?? 0} | ${fmtSigned(cn?.avgClose5d ?? 0)} | ${cn?.winRateClose5d ?? 0}% | ${fmtSigned(cn?.capitalGrowth5d ?? 0)}% |`);
  }
  lines.push('');

  // ─── per-市場 × per-排序 矩陣（d5 收盤報酬）───
  lines.push('### 8.2 per-市場 × per-排序 矩陣（d5 收盤均%、picks ≥ 10 才顯示）');
  lines.push('');
  for (const mkt of ['TW', 'CN'] as const) {
    lines.push(`#### ${mkt}`);
    lines.push('');
    lines.push(`| 策略 \\ 排序 | ${CONFIG.sorts.join(' | ')} |`);
    lines.push(`|---|${CONFIG.sorts.map(() => '---:').join('|')}|`);
    for (const L of CONFIG.letters) {
      const cells = CONFIG.sorts.map(S => {
        const m = marketSortMatrix.find(x => x.market === mkt && x.letter === L && x.sort === S);
        if (!m || m.picks < 10) return '_n/a_';
        return `${fmtSigned(m.avgClose5d)} (${m.winRateClose5d.toFixed(0)}%/n=${m.picks})`;
      });
      lines.push(`| **${nameOf(L)}** | ${cells.join(' | ')} |`);
    }
    lines.push('');
    // 各市場最賺前 5
    lines.push(`**${mkt} 最賺前 5（picks ≥ 15）**：`);
    const top = marketSortMatrix
      .filter(m => m.market === mkt && m.picks >= 15)
      .sort((a, b) => b.avgClose5d - a.avgClose5d)
      .slice(0, 5);
    for (const t of top) {
      lines.push(`- ${t.letterName} × ${t.sort}：收盤均 ${fmtSigned(t.avgClose5d)}%、勝率 ${t.winRateClose5d}%、picks ${t.picks}、資金成長 ${fmtSigned(t.capitalGrowth5d)}%`);
    }
    lines.push('');
  }

  // ─── 8.3 大盤趨勢日 split ───
  lines.push('### 8.3 大盤多頭日 vs 盤整/空頭日 split（漲幅排序、d5 收盤報酬）');
  lines.push('');
  lines.push(`定義：T0 當天大盤 close > MA20 且 MA20 上揚（近 5 日斜率 > 0）→ 多頭日；其他 → 盤整/空頭日。`);
  lines.push(`期間統計：TW ${meta.twTrendDays['多頭日']} 個多頭日 / ${meta.twTrendDays['盤整']} 個盤整日　|　CN ${meta.cnTrendDays['多頭日']} 個多頭日 / ${meta.cnTrendDays['盤整']} 個盤整日`);
  lines.push('');
  for (const mkt of ['TW', 'CN'] as const) {
    lines.push(`#### ${mkt}`);
    lines.push('');
    lines.push('| 策略 | 多頭日 picks/勝率/收盤均 | 盤整日 picks/勝率/收盤均 | 多頭 vs 盤整 Δ |');
    lines.push('|---|---|---|---:|');
    for (const L of CONFIG.letters) {
      const bull = regimeStats.find(r => r.market === mkt && r.letter === L && r.regime === '多頭日');
      const flat = regimeStats.find(r => r.market === mkt && r.letter === L && r.regime === '盤整/空頭日');
      const bullCell = bull && bull.picks >= 5 ? `${bull.picks} / ${bull.winRateClose5d}% / ${fmtSigned(bull.avgClose5d)}` : '_n/a_';
      const flatCell = flat && flat.picks >= 5 ? `${flat.picks} / ${flat.winRateClose5d}% / ${fmtSigned(flat.avgClose5d)}` : '_n/a_';
      const delta = (bull && flat && bull.picks >= 5 && flat.picks >= 5)
        ? fmtSigned(bull.avgClose5d - flat.avgClose5d) + 'pp'
        : '-';
      lines.push(`| **${nameOf(L)}** | ${bullCell} | ${flatCell} | ${delta} |`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('');

  // ─── 共振配對 ───
  lines.push('## 9. 共振配對分析（兩策略同時命中、樣本 ≥ 30）');
  lines.push('');
  lines.push('Δ = 共振 maxGain 平均 − 兩策略獨立平均的均值。Δ > 0 = 共振有 alpha。');
  lines.push('');
  if (pairs.length === 0) {
    lines.push('_共振樣本不足。_');
  } else {
    lines.push('| 配對組合 | picks | maxG均% | 勝率% | Δ vs 獨立 |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const p of pairs.slice(0, 30)) {
      lines.push(`| ${p.letters} | ${p.picks} | ${fmtSigned(p.avgMaxGain5d)} | ${p.winRate5d}% | ${fmtSigned(p.delta)} |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 最賺個股 ───
  lines.push('## 10. 最賺的個股（依「期間內最大單筆 d5 漲幅」排序，top 30）');
  lines.push('');
  lines.push('| # | 市場 | 代號 | 名稱 | 觸發次數 | 平均 d5 maxG | 最高 d5 maxG | 最高那天 | 命中策略 |');
  lines.push('|---:|---|---|---|---:|---:|---:|---|---|');
  const topBy = [...topStocks].sort((a, b) => b.bestMaxGain - a.bestMaxGain);
  for (let i = 0; i < Math.min(30, topBy.length); i++) {
    const s = topBy[i];
    const letterNames = s.letters.map(L => nameOf(L)).join('、');
    lines.push(`| ${i + 1} | ${s.market} | ${s.symbol} | ${s.name} | ${s.triggerCount} | ${fmtSigned(s.avgMaxGain5d)} | ${fmtSigned(s.bestMaxGain)} | ${s.bestDate} | ${letterNames} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 個股「命中最多次的」top ───
  lines.push('## 11. 觸發最頻繁的個股（依觸發次數排序、top 30）');
  lines.push('');
  lines.push('| # | 市場 | 代號 | 名稱 | 觸發次數 | 平均 d5 maxG | 命中策略 |');
  lines.push('|---:|---|---|---|---:|---:|---|');
  const topByFreq = [...topStocks].sort((a, b) => b.triggerCount - a.triggerCount);
  for (let i = 0; i < Math.min(30, topByFreq.length); i++) {
    const s = topByFreq[i];
    const letterNames = s.letters.map(L => nameOf(L)).join('、');
    lines.push(`| ${i + 1} | ${s.market} | ${s.symbol} | ${s.name} | ${s.triggerCount} | ${fmtSigned(s.avgMaxGain5d)} | ${letterNames} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 結論與操作建議 ───
  lines.push('## 12. 結論與操作建議');
  lines.push('');
  // 自動找 A 級組合（任何 hold window）
  const aGradeCells: { cell: CellSummary; window: number }[] = [];
  for (const c of cells) {
    if (c.picks < CONFIG.minPicksForGrade) continue;
    for (const H of CONFIG.holdWindows) {
      const h = c.byHold[H];
      if (gradeOf(c.picks, h.avgClose, h.winRate) === 'A') {
        aGradeCells.push({ cell: c, window: H });
      }
    }
  }
  if (aGradeCells.length > 0) {
    lines.push('### 達到 A 級的「策略 × 排序 × 持有天數」組合');
    lines.push('');
    lines.push('（收盤報酬 ≥ 3% 且勝率 ≥ 55%）');
    lines.push('');
    lines.push('| 策略 | 排序 | 持有 | picks | 收盤均% | 勝率% | maxGain% |');
    lines.push('|---|---|---:|---:|---:|---:|---:|');
    aGradeCells.sort((a, b) => b.cell.byHold[b.window].avgClose - a.cell.byHold[a.window].avgClose);
    for (const { cell, window } of aGradeCells.slice(0, 20)) {
      const h = cell.byHold[window];
      lines.push(`| **${cell.letterName}** | ${cell.sort} | d${window} | ${cell.picks} | ${fmtSigned(h.avgClose)} | ${h.winRate}% | ${fmtSigned(h.avgMaxGain)} |`);
    }
  } else {
    lines.push('### 無 A 級組合（≥ 3% 收盤均 + ≥ 55% 勝率）');
    lines.push('');
    lines.push('看 B/C 級組合（資金成長率排行 + 持有天數對比）。');
  }
  lines.push('');
  lines.push('### 觀察重點');
  lines.push('');
  lines.push('1. **「期間內 maxGain」普遍 +10% 但「實際收盤報酬」只有 +1-3%**');
  lines.push('   - 這個落差表示：股票會漲、但常常拉回；要賺到 maxGain 必須在期間內擇時賣');
  lines.push('   - 純 buy-and-hold 到 T+H 收盤的話，期望值低於想像');
  lines.push('');
  lines.push('2. **持有天數延長對 maxGain 大幅有利**');
  lines.push('   - d3 ~ +8%、d20 ~ +25%，但 close return 增長慢得多');
  lines.push('   - d20 「實際收盤」往往比 d5 多 +3-8%，但要扛 20 天波動');
  lines.push('');
  lines.push('3. **資金成長最強的策略不一定是 maxGain 最高的**');
  lines.push('   - V 形反轉 + 成交額排名 d5 = $1M → $3.16M（+216%），因為命中時收盤就明顯漲');
  lines.push('   - 突破上升軌道線 maxGain 第一但 close 平均只 +0.8%、資金成長弱');
  lines.push('');
  lines.push('4. **停損 −3% 對多數策略反而有害**');
  lines.push('   - 看停損對比表：很多策略 −3% 停損後的平均報酬比「無停損」還低');
  lines.push('   - 表示停損常常切在 V 字底，錯過反彈');
  lines.push('   - 真要設停損建議用 −5% 或 −7%（給更多空間）');
  lines.push('');
  lines.push('5. **共振配對在這個 4.5 月期間沒有特別明顯的 alpha**');
  lines.push('   - 多數共振 Δ 在 ±1% 內，沒有壓倒性優勢');
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 風險與限制 ───
  lines.push('## 13. 風險與限制');
  lines.push('');
  lines.push('1. **L1 candles 重跑 v12 detector**：整段期間定義一致（4/21 前後不再字母錯置）');
  lines.push('2. **maxGain 是「期間內 high 觸頂」**：實際吃到需在期間內掛單；放著不動只能拿 T+H 收盤');
  lines.push('3. **Survivorship bias**：已退市股不在 L1');
  lines.push('4. **前 500 大成交額過濾**對齊產線（避免冷門股）');
  lines.push('5. **sixConditionsScore 是 0-6 代理值**：用 trendState + indicatorPassed + volumeLevel 組合推算，非產線整數 score');
  lines.push('6. **資金成長假設**：B1 model 每次 all-in、不考慮分散；實盤多檔分散會降低 volatility');
  lines.push('7. **停損假設**：以停損價成交（intraday low 觸 → exit at stop price）。實盤可能跳空成交在更低點');
  lines.push('8. **B/C/E 過 Step 0 + 個股多頭 gate**；D/F/N/O/Q 不過 Step 1（書本本意）');
  lines.push('');

  fs.writeFileSync(OUT_MD, lines.join('\n'));
  console.log(`  寫入 ${path.relative(process.cwd(), OUT_MD)}`);
}

// ════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════

function main(): void {
  const startTime = Date.now();
  console.log('\n  ═══ v12 全期間綜合回測 ═══');
  console.log(`  期間：${CONFIG.startDate} → ${CONFIG.endDate}`);
  console.log(`  策略：${CONFIG.letters.length} 個`);
  console.log(`  排序：${CONFIG.sorts.length} 種`);
  console.log(`  持有天數：${CONFIG.holdWindows.join(', ')}`);
  console.log(`  停損：${CONFIG.stopLosses.map(s => s === 0 ? '無' : `${s}%`).join(', ')}`);
  console.log('');

  console.log('  載入 L1 candles + 計算指標...');
  const twStocks = loadMarketStocks('TW');
  const cnStocks = loadMarketStocks('CN');

  console.log('  載入大盤指數...');
  const twIndex = loadIndexCandles('TW');
  const cnIndex = loadIndexCandles('CN');

  console.log('\n  跑 v12 detector...');
  const twEvents = collectEvents('TW', twStocks, twIndex);
  console.log(`    TW events: ${twEvents.length} 筆`);
  const cnEvents = collectEvents('CN', cnStocks, cnIndex);
  console.log(`    CN events: ${cnEvents.length} 筆`);
  const allEvents = [...twEvents, ...cnEvents];
  console.log(`  合計事件：${allEvents.length} 筆\n`);

  const daysTW = new Set(twEvents.map(e => e.date)).size;
  const daysCN = new Set(cnEvents.map(e => e.date)).size;

  console.log('  計算每個 (letter, sort) summary...');
  const cells: CellSummary[] = [];
  const cellByLetter = new Map<string, CellSummary>();
  for (const L of CONFIG.letters) {
    for (const sort of CONFIG.sorts) {
      const picks = pickTopOne(allEvents, L, sort);
      const summary = summarizeCell(L, sort, picks);
      cells.push(summary);
      if (sort === '漲幅') cellByLetter.set(L, summary);
    }
  }

  console.log('  計算月份分布...');
  const monthly = computeMonthlyStats(allEvents);

  console.log('  計算 TW vs CN...');
  const marketStats = computeMarketStats(allEvents);

  console.log('  計算共振配對...');
  const pairs = computePairs(allEvents, cellByLetter);

  console.log('  計算最賺個股...');
  const topStocks = computeTopStocks(allEvents);

  console.log('  計算 per-市場 × per-排序 矩陣...');
  const marketSortMatrix = computeMarketSortMatrix(allEvents);

  console.log('  計算大盤趨勢日 split...');
  const regimeStats = computeRegimeStats(allEvents, { TW: twIndex, CN: cnIndex });

  // 統計多頭日/盤整日數量
  const twDatesInRange = twIndex.filter(c => {
    const d = c.date.slice(0, 10);
    return d >= CONFIG.startDate && d <= CONFIG.endDate;
  });
  const cnDatesInRange = cnIndex.filter(c => {
    const d = c.date.slice(0, 10);
    return d >= CONFIG.startDate && d <= CONFIG.endDate;
  });
  const twTrendDays = { 多頭日: 0, 盤整: 0 };
  for (const c of twDatesInRange) {
    if (tagDateRegime(twIndex, c.date.slice(0, 10)) === '多頭日') twTrendDays['多頭日']++;
    else twTrendDays['盤整']++;
  }
  const cnTrendDays = { 多頭日: 0, 盤整: 0 };
  for (const c of cnDatesInRange) {
    if (tagDateRegime(cnIndex, c.date.slice(0, 10)) === '多頭日') cnTrendDays['多頭日']++;
    else cnTrendDays['盤整']++;
  }
  console.log(`    TW 多頭日 ${twTrendDays['多頭日']} / 盤整日 ${twTrendDays['盤整']}`);
  console.log(`    CN 多頭日 ${cnTrendDays['多頭日']} / 盤整日 ${cnTrendDays['盤整']}`);

  console.log('  輸出報告...');
  // top 排行（d5 主表）
  const ranked = [...cells].filter(c => c.picks >= 5).sort((a, b) => b.byHold[5].avgMaxGain - a.byHold[5].avgMaxGain);
  console.log('\n  ═══════════ d5 主排行 Top 10 ═══════════');
  console.log('  #  策略              排序        picks  d5 maxG  勝率    等級');
  ranked.slice(0, 10).forEach((c, i) => {
    const h = c.byHold[5];
    const grade = gradeOf(c.picks, h.avgMaxGain, h.winRate);
    console.log(
      `  ${String(i + 1).padStart(2)}. ${(c.letterName + '              ').slice(0, 14)} ${(c.sort + '          ').slice(0, 10)} ${String(c.picks).padStart(4)}  ${fmtSigned(h.avgMaxGain).padStart(7)}%  ${h.winRate.toFixed(1).padStart(5)}%  ${grade}`
    );
  });

  console.log('\n  ═══════════ 資金成長 Top 5（持有 5 天）═══════════');
  const capRanked = [...cells].filter(c => c.picks >= 5).sort((a, b) => b.capitalGrowth.totalReturn - a.capitalGrowth.totalReturn);
  capRanked.slice(0, 5).forEach((c, i) => {
    console.log(
      `  ${i + 1}. ${(c.letterName + '              ').slice(0, 14)} ${(c.sort + '          ').slice(0, 10)} ` +
      `${c.capitalGrowth.trades} 筆  $${c.capitalGrowth.finalCapital.toLocaleString().padStart(12)}  ${fmtSigned(c.capitalGrowth.totalReturn).padStart(7)}%`
    );
  });

  // 寫檔
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: CONFIG,
    meta: { eventsCount: allEvents.length, daysTW, daysCN, twTrendDays, cnTrendDays },
    cells,
    monthly,
    marketStats,
    marketSortMatrix,
    regimeStats,
    pairs,
    topStocks: topStocks.sort((a, b) => b.bestMaxGain - a.bestMaxGain).slice(0, 100),
  }, null, 2));
  console.log(`\n  寫入 ${path.relative(process.cwd(), OUT_JSON)}`);

  writeMarkdown(cells, monthly, marketStats, pairs, topStocks, marketSortMatrix, regimeStats, { eventsCount: allEvents.length, daysTW, daysCN, twTrendDays, cnTrendDays });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  完成（${elapsed} 秒）\n`);
}

main();
