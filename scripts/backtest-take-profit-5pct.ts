/**
 * +5% 限價單回測：模擬「T0 收盤買、隔天起掛 +5% 限價賣、N 天不到收盤平倉」
 *
 * 期間：依環境變數 BACKTEST_START / BACKTEST_END / BACKTEST_LABEL
 * 策略：v12 全 13 字母
 *
 * 核心邏輯：
 *   entryPrice = T0 close
 *   takeProfit = entryPrice × 1.05
 *   遍歷 T+1..T+maxHold：若 high ≥ takeProfit → 命中、報酬 = +5%、出場日 = 該日
 *   全部沒命中 → 強制 T+maxHold 收盤平倉、報酬 = (close − entry) / entry
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=12288" BACKTEST_START=2025-05-12 \
 *     BACKTEST_END=2026-05-12 BACKTEST_LABEL=1y npx tsx scripts/backtest-take-profit-5pct.ts
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
  label: process.env.BACKTEST_LABEL ?? '',
  letters: ['B','C','D','E','F','J','K','L','M','N','O','P','Q'] as const,
  sorts: ['漲幅', '六條件', '成交額排名', '面板對齊'] as const,
  maxHolds: [3, 5, 10] as const,
  takeProfitPct: 5,
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
const OUT_JSON = path.join(ROOT, `backtest_take_profit_5pct${SUFFIX}.json`);
const OUT_MD_DIR = path.join(ROOT, 'backtest-output');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_MD = path.join(OUT_MD_DIR, `take-profit-5pct${CONFIG.label ? '-' + CONFIG.label : ''}-${TODAY}.md`);

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

interface SimResult {
  hit: boolean;
  exitDay: number;          // 1..maxHold；命中時為觸發日，未命中為 maxHold
  returnPct: number;        // 命中固定 +5；未命中為 T+maxHold close 報酬
  /** 漲停股標記：T0 changePercent > 9.5 */
  limitUpAtEntry: boolean;
  /** T+1 開盤跳空高開且 ≥ 5%：跳空進場優勢 */
  gapHit: boolean;
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
  /** per maxHold 的模擬結果 */
  sims: Record<number, SimResult | null>;
}

interface Pick {
  market: 'TW' | 'CN';
  date: string;
  symbol: string;
  name: string;
  matchedMethods: V12Letter[];
  changePercent: number;
  sims: Record<number, SimResult | null>;
}

interface CellStats {
  market: 'TW' | 'CN';
  letter: string;
  letterName: string;
  sort: string;
  track: string;
  maxHold: number;
  picks: number;
  hit5Rate: number;          // %
  avgExitDay: number;        // 命中時的平均出場日
  missReturn: number;        // 未命中的平均強制平倉報酬
  netReturn: number;         // 混合平均（命中+5、未命中拿 missReturn）
  expectedValue: number;     // = hit5Rate/100 × 5 + (1 − hit5Rate/100) × missReturn
  limitUpEntryPct: number;   // 漲停進場佔比
  gapHitPct: number;         // 跳空高開 ≥5% 佔比
  grade: 'A' | 'B' | 'C' | 'D' | 'low-sample' | 'tentative';
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
// 限價單模擬（核心）
// ════════════════════════════════════════════════════════════════

function simulateTakeProfit(stock: StockData, t0Date: string, maxHold: number): SimResult | null {
  const t0 = stock.dateToIdx.get(t0Date);
  if (t0 == null) return null;
  if (t0 + maxHold >= stock.candles.length) return null;
  const entryPrice = stock.candles[t0].close;
  if (entryPrice <= 0) return null;
  const takeProfit = entryPrice * (1 + CONFIG.takeProfitPct / 100);

  // 漲停股標記（T0 漲幅 > 9.5%）
  const prev = t0 > 0 ? stock.candles[t0 - 1] : null;
  const changePercent = prev && prev.close > 0 ? (entryPrice - prev.close) / prev.close * 100 : 0;
  const limitUpAtEntry = changePercent > 9.5;

  // T+1 開盤跳空高開 ≥ +5%
  const t1Open = stock.candles[t0 + 1].open;
  const gapHit = t1Open >= takeProfit;

  // 遍歷 T+1..T+maxHold 找命中
  for (let d = 1; d <= maxHold; d++) {
    const c = stock.candles[t0 + d];
    if (c.high >= takeProfit) {
      return {
        hit: true,
        exitDay: d,
        returnPct: CONFIG.takeProfitPct,
        limitUpAtEntry,
        gapHit,
      };
    }
  }

  // 沒命中 → T+maxHold 收盤強制平倉
  const exitClose = stock.candles[t0 + maxHold].close;
  return {
    hit: false,
    exitDay: maxHold,
    returnPct: (exitClose - entryPrice) / entryPrice * 100,
    limitUpAtEntry,
    gapHit,
  };
}

// ════════════════════════════════════════════════════════════════
// turnover 排名
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

        // 對每個 maxHold 跑模擬
        const sims: Record<number, SimResult | null> = {};
        for (const H of CONFIG.maxHolds) sims[H] = simulateTakeProfit(s, date, H);

        events.push({
          market: s.market, date,
          symbol: s.symbol, name: s.name,
          matchedMethods: triggered,
          sixConditionsScore: sixScore,
          step1Passed,
          changePercent,
          turnoverRank: r,
          sims,
        });
      } catch { /* skip */ }
    }
    processed++;
    if (processed % 20 === 0) process.stdout.write(`    [${market}] ${processed}/${dates.length}\n`);
  }
  return events;
}

// ════════════════════════════════════════════════════════════════
// 排序 + 取 top-1
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

function pickTopOne(events: EvalEvent[], letter: string, sort: typeof CONFIG.sorts[number]): Pick[] {
  const sortFn = SORT_FNS[sort];
  const byDayMarket = new Map<string, EvalEvent[]>();
  for (const e of events) {
    if (!e.matchedMethods.includes(letter as V12Letter)) continue;
    if (!passesProductionGate(letter, e)) continue;
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
      changePercent: top.changePercent,
      sims: top.sims,
    });
  }
  return picks;
}

// ════════════════════════════════════════════════════════════════
// 統計工具
// ════════════════════════════════════════════════════════════════

function mean(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function round(x: number, p = 2): number { const f = Math.pow(10, p); return Math.round(x * f) / f; }
function fmtSigned(x: number): string { return (x >= 0 ? '+' : '') + x.toFixed(2); }

function gradeCell(picks: number, hit5Rate: number, ev: number): CellStats['grade'] {
  if (picks < 5) return 'low-sample';
  if (picks < CONFIG.minPicksForGrade) return 'tentative';
  if (hit5Rate >= 70 && ev >= 3) return 'A';
  if (hit5Rate >= 60 && ev >= 2) return 'B';
  if (hit5Rate >= 50 && ev >= 1) return 'C';
  return 'D';
}

function summarizeCell(market: 'TW' | 'CN', letter: string, sort: string, maxHold: number, picks: Pick[]): CellStats {
  const valid = picks.filter(p => p.sims[maxHold] != null);
  const hits = valid.filter(p => p.sims[maxHold]!.hit);
  const misses = valid.filter(p => !p.sims[maxHold]!.hit);
  const hitRate = valid.length ? hits.length / valid.length * 100 : 0;
  const avgExit = hits.length ? mean(hits.map(p => p.sims[maxHold]!.exitDay)) : 0;
  const missRet = misses.length ? mean(misses.map(p => p.sims[maxHold]!.returnPct)) : 0;
  const netRet = valid.length ? mean(valid.map(p => p.sims[maxHold]!.returnPct)) : 0;
  const ev = hitRate / 100 * CONFIG.takeProfitPct + (1 - hitRate / 100) * missRet;
  const limitUpCount = valid.filter(p => p.sims[maxHold]!.limitUpAtEntry).length;
  const gapHitCount = valid.filter(p => p.sims[maxHold]!.gapHit).length;

  return {
    market,
    letter,
    letterName: STRATEGY_NAME[letter] ?? letter,
    sort,
    track: TRACK_LABEL[letter] ?? '-',
    maxHold,
    picks: valid.length,
    hit5Rate: round(hitRate, 1),
    avgExitDay: round(avgExit, 2),
    missReturn: round(missRet),
    netReturn: round(netRet),
    expectedValue: round(ev),
    limitUpEntryPct: round(valid.length ? limitUpCount / valid.length * 100 : 0, 1),
    gapHitPct: round(valid.length ? gapHitCount / valid.length * 100 : 0, 1),
    grade: gradeCell(valid.length, hitRate, ev),
  };
}

// ════════════════════════════════════════════════════════════════
// Markdown 輸出
// ════════════════════════════════════════════════════════════════

const nameOf = (L: string) => STRATEGY_NAME[L] ?? L;

function writeMarkdown(cells: CellStats[], meta: { eventsTW: number; eventsCN: number; daysTW: number; daysCN: number }): void {
  if (!fs.existsSync(OUT_MD_DIR)) fs.mkdirSync(OUT_MD_DIR, { recursive: true });
  const lines: string[] = [];

  lines.push(`# +5% 限價單回測報告（${CONFIG.startDate} → ${CONFIG.endDate}）`);
  lines.push('');
  lines.push(`產出時間：${new Date().toISOString()}　|　Label: ${CONFIG.label || '(default)'}`);
  lines.push('');
  lines.push(`**情境**：T0 收盤買進、T+1 起掛 +5% 限價賣單、N 天未觸發收盤強制平倉、無停損`);
  lines.push(`**期間**：${CONFIG.startDate} → ${CONFIG.endDate}　|　TW ${meta.daysTW} 天 / ${meta.eventsTW} 事件　|　CN ${meta.daysCN} 天 / ${meta.eventsCN} 事件`);
  lines.push(`**maxHold**：${CONFIG.maxHolds.join(' / ')} 天　|　**takeProfit**：+${CONFIG.takeProfitPct}%`);
  lines.push('');
  lines.push('**等級判定**：A = hit5Rate ≥ 70% 且 EV ≥ 3%　|　B = ≥ 60% 且 ≥ 2%　|　C = ≥ 50% 且 ≥ 1%　|　picks < 30 標 tentative');
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── TL;DR ───
  lines.push('## TL;DR');
  lines.push('');
  for (const mkt of ['TW', 'CN'] as const) {
    for (const H of CONFIG.maxHolds) {
      const sorted = cells
        .filter(c => c.market === mkt && c.maxHold === H && c.picks >= CONFIG.minPicksForGrade)
        .sort((a, b) => b.expectedValue - a.expectedValue);
      const top = sorted[0];
      if (!top) continue;
      lines.push(`- **${mkt} × maxHold ${H} 最佳**：${top.letterName} × ${top.sort}（hit5Rate ${top.hit5Rate}%、EV ${fmtSigned(top.expectedValue)}%、平均 ${top.avgExitDay} 天觸發、未命中 ${fmtSigned(top.missReturn)}%、picks ${top.picks}、${top.grade}）`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 每市場 × 每 maxHold 表 ───
  for (const mkt of ['TW', 'CN'] as const) {
    lines.push(`## ${mkt}`);
    lines.push('');
    for (const H of CONFIG.maxHolds) {
      lines.push(`### maxHold = ${H} 天`);
      lines.push('');
      lines.push('| 策略 | 排序 | picks | hit5Rate | 平均觸發日 | 未命中報酬 | EV | 漲停進場% | 跳空高開% | 等級 |');
      lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|:--:|');
      const sorted = cells
        .filter(c => c.market === mkt && c.maxHold === H && c.picks >= 5)
        .sort((a, b) => b.expectedValue - a.expectedValue);
      for (const c of sorted) {
        lines.push(`| **${c.letterName}** | ${c.sort} | ${c.picks} | ${c.hit5Rate.toFixed(1)}% | ${c.avgExitDay.toFixed(2)} | ${fmtSigned(c.missReturn)}% | ${fmtSigned(c.expectedValue)}% | ${c.limitUpEntryPct.toFixed(1)}% | ${c.gapHitPct.toFixed(1)}% | **${c.grade}** |`);
      }
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('');

  // ─── 結論 ───
  lines.push('## 結論');
  lines.push('');
  for (const mkt of ['TW', 'CN'] as const) {
    lines.push(`### ${mkt}`);
    // 找該市場所有 maxHold 裡 EV 最高的組合
    const best = cells
      .filter(c => c.market === mkt && c.picks >= CONFIG.minPicksForGrade)
      .sort((a, b) => b.expectedValue - a.expectedValue)[0];
    if (best) {
      lines.push(`- **最佳組合**：${best.letterName} × ${best.sort} × maxHold ${best.maxHold} 天`);
      lines.push(`- hit5Rate ${best.hit5Rate}% / EV ${fmtSigned(best.expectedValue)}% / 平均 ${best.avgExitDay} 天觸發 / picks ${best.picks} / ${best.grade}`);
    } else {
      lines.push(`- 無 picks ≥ ${CONFIG.minPicksForGrade} 的組合`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 風險與限制');
  lines.push('');
  lines.push('1. **跳空高開觸發**：T+1 開盤 ≥ takeProfit 時實盤可能成交於開盤價（高於 +5%），本回測仍記 +5%（保守）。「跳空高開%」欄位顯示這類比例。');
  lines.push('2. **CN 漲停 10% 後座力**：T0 已漲停的股、T+1 跳空高開常見 → hit5Rate 可能偏高。看「漲停進場%」欄位判讀。');
  lines.push('3. **無停損假設**：未命中時 T+maxHold 收盤強平。實盤若加 −5%/−7% 停損會改變 missReturn 分布。');
  lines.push('4. **盤中限價單實務**：限價單以「當日 high ≥ takeProfit」判定命中，假設 +5% 限價單一定能在 high 觸及時成交。實際可能有部分成交、滑點等。');
  lines.push('5. **Survivorship bias**：已退市股不在 L1。');
  lines.push('6. **前 500 大成交額過濾**：對齊產線 ScanPipeline。');

  fs.writeFileSync(OUT_MD, lines.join('\n'));
  console.log(`  寫入 ${path.relative(process.cwd(), OUT_MD)}`);
}

// ════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════

function main(): void {
  const startTime = Date.now();
  console.log('\n  ═══ +5% 限價單回測 ═══');
  console.log(`  期間：${CONFIG.startDate} → ${CONFIG.endDate}${CONFIG.label ? ` (label=${CONFIG.label})` : ''}`);
  console.log(`  maxHold：${CONFIG.maxHolds.join(', ')} 天　takeProfit：+${CONFIG.takeProfitPct}%`);
  console.log('');

  console.log('  載入 L1...');
  const twStocks = loadMarketStocks('TW');
  const cnStocks = loadMarketStocks('CN');
  const twIndex = loadIndexCandles('TW');
  const cnIndex = loadIndexCandles('CN');

  console.log('\n  跑 v12 detector + 模擬限價單...');
  const twEvents = collectEvents('TW', twStocks, twIndex);
  console.log(`    TW events: ${twEvents.length}`);
  const cnEvents = collectEvents('CN', cnStocks, cnIndex);
  console.log(`    CN events: ${cnEvents.length}`);
  const allEvents = [...twEvents, ...cnEvents];

  const daysTW = new Set(twEvents.map(e => e.date)).size;
  const daysCN = new Set(cnEvents.map(e => e.date)).size;

  console.log('\n  計算 cells...');
  const cells: CellStats[] = [];
  for (const mkt of ['TW', 'CN'] as const) {
    const mktEvents = allEvents.filter(e => e.market === mkt);
    for (const L of CONFIG.letters) {
      for (const sort of CONFIG.sorts) {
        const picks = pickTopOne(mktEvents, L, sort);
        for (const H of CONFIG.maxHolds) {
          cells.push(summarizeCell(mkt, L, sort, H, picks));
        }
      }
    }
  }

  // 控制台 Top 10 (依 maxHold=5 EV)
  console.log('\n  ═══ Top 10（依 maxHold=5、EV 排序、picks ≥ 30）═══');
  console.log('  市場 | 策略           | 排序     | hit5%  | EV     | 平均觸發日 | 未命中');
  const ranked = cells.filter(c => c.maxHold === 5 && c.picks >= CONFIG.minPicksForGrade).sort((a, b) => b.expectedValue - a.expectedValue);
  ranked.slice(0, 10).forEach((c) => {
    console.log(
      `  ${c.market}   | ${(c.letterName + '              ').slice(0, 14)} | ${(c.sort + '        ').slice(0, 8)} | ${c.hit5Rate.toFixed(1).padStart(5)}% | ${fmtSigned(c.expectedValue).padStart(6)}% | ${c.avgExitDay.toFixed(2).padStart(8)} | ${fmtSigned(c.missReturn).padStart(6)}%`
    );
  });

  // 寫檔
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: CONFIG,
    meta: { eventsTW: twEvents.length, eventsCN: cnEvents.length, daysTW, daysCN },
    cells,
  }, null, 2));
  console.log(`\n  寫入 ${path.relative(process.cwd(), OUT_JSON)}`);
  writeMarkdown(cells, { eventsTW: twEvents.length, eventsCN: cnEvents.length, daysTW, daysCN });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  完成（${elapsed} 秒）\n`);
}

main();
