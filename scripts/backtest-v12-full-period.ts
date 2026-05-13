/**
 * v12 全期間回測：對歷史每個 (date, symbol) 跑 v12 detector，每天每策略取排序第 1 名，算 3 天內最大漲幅。
 *
 * 期間：2026-01-01 → 2026-05-12（約 4.5 個月）
 * 策略：v12 全 13 字母（B/C/D/E/F/J/K/L/M/N/O/P/Q）
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-v12-full-period.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { evaluateStockV12 } from '@/lib/scanner/v12StockEvaluator';
import type { V12Letter } from '@/lib/analysis/v12Signals';
import type { CandleWithIndicators } from '@/types';
// Legacy detectors（v12 evaluator 不跑這 5 個，需手動補）
import { detectBreakoutEntry, detectConsolidationBreakout } from '@/lib/analysis/breakoutEntry';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';

// ════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════

const CONFIG = {
  startDate: '2026-01-01',
  endDate: '2026-05-12',
  holdDays: 3,
  letters: ['B','C','D','E','F','J','K','L','M','N','O','P','Q'] as const,
  sorts: ['漲幅', '六條件', 'MTF', '成交額排名', '面板對齊'] as const,
  minPicksForGrade: 30,
  topNTurnover: 500,    // 對齊產線 ScanPipeline 前 500 大成交額過濾
} as const;

const STRATEGY_NAME: Record<string, string> = {
  B: '回後買上漲',
  C: '盤整突破',
  D: '一字底突破',
  E: '缺口進場',
  F: 'V 形反轉',
  J: 'ABC 突破',
  K: 'K 線橫盤突破',
  L: '過大量黑 K 高',
  M: '突破上升軌道線',
  N: '型態確認',
  O: '打底完成',
  P: '高檔拉回',
  Q: '三均線戰法',
};

const TRACK_LABEL: Record<string, string> = {
  B: '多頭', C: '多頭', E: '多頭', M: '多頭', P: '多頭',
  J: '多頭', K: '多頭', L: '多頭',
  D: '反轉', F: '反轉', N: '反轉', O: '反轉',
  Q: '戰法',
};

const ROOT = path.join(process.cwd(), 'data');
const CANDLE_ROOT = path.join(ROOT, 'candles');
const OUT_JSON = path.join(ROOT, 'backtest_v12_full_period.json');
const OUT_MD_DIR = path.join(ROOT, 'backtest-output');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_MD = path.join(OUT_MD_DIR, `v12-full-${CONFIG.startDate}-${CONFIG.endDate}-${TODAY}.md`);

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

interface EvalEvent {
  market: 'TW' | 'CN';
  date: string;
  symbol: string;
  name: string;
  matchedMethods: V12Letter[];
  sixConditionsScore: number;     // proxy
  step1Passed: boolean;
  changePercent: number;
  turnoverRank: number;
}

interface Pick {
  market: 'TW' | 'CN';
  date: string;
  symbol: string;
  name: string;
  maxGain: number | null;
  d3CloseReturn: number | null;
  worstLow: number | null;
}

interface CellStats {
  letter: string;
  sort: string;
  track: string;
  picks: number;
  avgMaxGain: number;
  medMaxGain: number;
  avgD3Close: number;
  winRateMaxGain: number;
  winRateD3Close: number;
  hitRate5pct: number;
  worstLowAvg: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'tentative' | 'low-sample';
}

// ════════════════════════════════════════════════════════════════
// 載入 L1 candles + 算 indicators（一次）
// ════════════════════════════════════════════════════════════════

function loadMarketStocks(market: 'TW' | 'CN'): StockData[] {
  const dir = path.join(CANDLE_ROOT, market);
  if (!fs.existsSync(dir)) {
    console.error(`  ${market} candles 目錄不存在：${dir}`);
    return [];
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  // 排除指數 + ST 股
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
  if (!fs.existsSync(file)) { console.error(`  指數檔不存在：${file}`); return []; }
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
// 算每日成交額排名（前 N 過濾）
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
// 主迴圈：跑 v12 detector 收集 events
// ════════════════════════════════════════════════════════════════

function collectEvents(market: 'TW' | 'CN', stocks: StockData[], indexCandles: CandleWithIndicators[]): EvalEvent[] {
  const events: EvalEvent[] = [];
  // 取得 universe 中所有交易日（聯集）→ 過濾在範圍內
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

    // 算當日 top-500 成交額過濾（對齊產線 ScanPipeline）
    const rank = turnoverRankForDay(stocks, date);

    for (const s of stocks) {
      const idx = s.dateToIdx.get(date);
      if (idx == null || idx < 60) continue;  // 需要至少 60 根做指標
      const r = rank.get(s.symbol);
      if (r == null || r > CONFIG.topNTurnover) continue;

      try {
        const result = evaluateStockV12({
          symbol: s.symbol,
          name: s.name,
          market: s.market,
          candles: s.candles,
          indexCandles: indexSlice,
          index: idx,
        });
        const triggered: V12Letter[] = result.signals.filter(sig => sig.triggered).map(sig => sig.letter);

        // 補跑 v12 evaluator 不涵蓋的 B/C/D/E/F legacy detector
        // 多頭軌 (B/C/E) 必須 Step 0 大盤過、個股多頭
        const marketPassed = result.marketGate.passed;
        const isLongTrend = result.step1.trendState === '多頭';
        if (marketPassed && isLongTrend) {
          if (detectBreakoutEntry(s.candles, idx)) triggered.push('B' as V12Letter);
          if (detectConsolidationBreakout(s.candles, idx)) triggered.push('C' as V12Letter);
          if (detectStrategyD(s.candles, idx)) triggered.push('E' as V12Letter);
        }
        // 反轉軌 D/F 不過 Step 1，但 D 一字底通常要求多頭基底；保守起見不加大盤閘
        if (detectStrategyE(s.candles, idx)) triggered.push('D' as V12Letter);
        if (detectVReversal(s.candles, idx)) triggered.push('F' as V12Letter);

        if (triggered.length === 0) continue;

        const prev = idx > 0 ? s.candles[idx - 1] : null;
        const changePercent = prev && prev.close > 0
          ? (s.candles[idx].close - prev.close) / prev.close * 100
          : 0;
        // sixConditionsScore: 由 step1 推得
        const indicatorOK = result.step1.indicatorPassed;
        const volumeNormalOrClimax = result.step1.volumeLevel != null;
        // step1Passed ≈ 多頭軌可以過 = isLongTrend + indicatorOK + volume
        const step1Passed = isLongTrend && indicatorOK && volumeNormalOrClimax;
        const sixConditionsScoreProxy = (isLongTrend ? 3 : 0) + (indicatorOK ? 2 : 0) + (volumeNormalOrClimax ? 1 : 0);

        events.push({
          market: s.market,
          date,
          symbol: s.symbol,
          name: s.name,
          matchedMethods: triggered as V12Letter[],
          sixConditionsScore: sixConditionsScoreProxy,
          step1Passed,
          changePercent,
          turnoverRank: r,
        });
      } catch {
        /* 個股錯誤跳過 */
      }
    }
    processed++;
    if (processed % 10 === 0) process.stdout.write(`    [${market}] 已處理 ${processed}/${dates.length} 天\n`);
  }
  return events;
}

// ════════════════════════════════════════════════════════════════
// 算 d3 maxGain
// ════════════════════════════════════════════════════════════════

function computeForward(stock: StockData, t0Date: string, holdDays: number): { maxGain: number | null; d3Close: number | null; worstLow: number | null } {
  const t0 = stock.dateToIdx.get(t0Date);
  if (t0 == null || t0 + holdDays >= stock.candles.length) return { maxGain: null, d3Close: null, worstLow: null };
  const entry = stock.candles[t0 + 1].open;
  if (entry <= 0) return { maxGain: null, d3Close: null, worstLow: null };
  let maxHigh = -Infinity, minLow = Infinity;
  for (let i = t0 + 1; i <= t0 + holdDays; i++) {
    if (stock.candles[i].high > maxHigh) maxHigh = stock.candles[i].high;
    if (stock.candles[i].low < minLow) minLow = stock.candles[i].low;
  }
  const exitClose = stock.candles[t0 + holdDays].close;
  return {
    maxGain: (maxHigh - entry) / entry * 100,
    d3Close: (exitClose - entry) / entry * 100,
    worstLow: (minLow - entry) / entry * 100,
  };
}

// ════════════════════════════════════════════════════════════════
// 排序
// ════════════════════════════════════════════════════════════════

const BULLISH_REQUIRES_STEP1 = new Set(['B', 'C', 'E', 'M', 'P', 'J', 'K', 'L']);

function passesProductionGate(letter: string, e: EvalEvent): boolean {
  if (BULLISH_REQUIRES_STEP1.has(letter)) return e.step1Passed;
  return true;
}

type SortKey = (e: EvalEvent) => number;
const SORT_FNS: Record<typeof CONFIG.sorts[number], SortKey> = {
  '漲幅': e => e.changePercent,
  '六條件': e => e.sixConditionsScore * 100 + e.changePercent / 100,
  'MTF': e => e.sixConditionsScore * 100 + e.changePercent / 100,  // 無 mtf 資料 → 退回六條件
  '成交額排名': e => -e.turnoverRank,
  '面板對齊': e => e.changePercent * 1000 + e.sixConditionsScore,
};

// ════════════════════════════════════════════════════════════════
// 統計
// ════════════════════════════════════════════════════════════════

function mean(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round(x: number, p = 2): number { const f = Math.pow(10, p); return Math.round(x * f) / f; }

function gradeCell(picks: number, avgMaxGain: number, winRate: number): CellStats['grade'] {
  if (picks < 5) return 'low-sample';
  if (picks < CONFIG.minPicksForGrade) return 'tentative';
  if (avgMaxGain >= 6 && winRate >= 75) return 'A';
  if (avgMaxGain >= 4 && winRate >= 65) return 'B';
  if (avgMaxGain >= 2 && winRate >= 55) return 'C';
  return 'D';
}

interface CellRun { letter: string; sort: string; picks: Pick[]; }

function runGrid(events: EvalEvent[], stocksByKey: Map<string, StockData>): CellRun[] {
  const byDayMarket = new Map<string, EvalEvent[]>();
  for (const e of events) {
    const k = `${e.market}|${e.date}`;
    const arr = byDayMarket.get(k) ?? [];
    arr.push(e);
    byDayMarket.set(k, arr);
  }

  const cells: CellRun[] = [];
  for (const letter of CONFIG.letters) {
    for (const sort of CONFIG.sorts) {
      const sortFn = SORT_FNS[sort];
      const picks: Pick[] = [];
      for (const [, dayEvents] of byDayMarket) {
        const candidates = dayEvents.filter(e =>
          e.matchedMethods.includes(letter as V12Letter) && passesProductionGate(letter, e)
        );
        if (!candidates.length) continue;
        candidates.sort((a, b) => sortFn(b) - sortFn(a));
        const top = candidates[0];
        const stock = stocksByKey.get(`${top.market}|${top.symbol}`);
        if (!stock) continue;
        const fwd = computeForward(stock, top.date, CONFIG.holdDays);
        picks.push({
          market: top.market, date: top.date,
          symbol: top.symbol, name: top.name,
          maxGain: fwd.maxGain, d3CloseReturn: fwd.d3Close, worstLow: fwd.worstLow,
        });
      }
      cells.push({ letter, sort, picks });
    }
  }
  return cells;
}

function summarize(cell: CellRun): CellStats {
  const valid = cell.picks.filter(p => p.maxGain != null && p.d3CloseReturn != null);
  const mg = valid.map(p => p.maxGain as number);
  const d3 = valid.map(p => p.d3CloseReturn as number);
  const wl = valid.map(p => p.worstLow as number);
  const avgMaxGain = mean(mg);
  const winRateMaxGain = mg.length ? mg.filter(x => x > 0).length / mg.length * 100 : 0;
  return {
    letter: cell.letter,
    sort: cell.sort,
    track: TRACK_LABEL[cell.letter] ?? '-',
    picks: valid.length,
    avgMaxGain: round(avgMaxGain),
    medMaxGain: round(median(mg)),
    avgD3Close: round(mean(d3)),
    winRateMaxGain: round(winRateMaxGain, 1),
    winRateD3Close: round(d3.length ? d3.filter(x => x > 0).length / d3.length * 100 : 0, 1),
    hitRate5pct: round(mg.length ? mg.filter(x => x >= 5).length / mg.length * 100 : 0, 1),
    worstLowAvg: round(mean(wl)),
    grade: gradeCell(valid.length, avgMaxGain, winRateMaxGain),
  };
}

// ════════════════════════════════════════════════════════════════
// 輸出
// ════════════════════════════════════════════════════════════════

function fmtSigned(x: number): string { return (x >= 0 ? '+' : '') + x.toFixed(2); }
const nameOf = (L: string) => STRATEGY_NAME[L] ?? L;

function writeJson(payload: object): void {
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
  console.log(`  寫入 ${path.relative(process.cwd(), OUT_JSON)}`);
}

function writeMarkdown(stats: CellStats[], topPicks: Map<string, Pick[]>, meta: { eventsCount: number; daysTW: number; daysCN: number }): void {
  if (!fs.existsSync(OUT_MD_DIR)) fs.mkdirSync(OUT_MD_DIR, { recursive: true });
  const lines: string[] = [];
  lines.push(`# v12 全期間回測報告（${CONFIG.startDate} → ${CONFIG.endDate}）`);
  lines.push('');
  lines.push(`產出時間：${new Date().toISOString()}　|　持有：${CONFIG.holdDays} 個交易日`);
  lines.push('');
  lines.push(`期間：${CONFIG.startDate} → ${CONFIG.endDate}　|　TW ${meta.daysTW} 天、CN ${meta.daysCN} 天　|　事件 ${meta.eventsCount} 筆`);
  lines.push('');
  lines.push(`規則：每天每市場從每個策略命中清單中、依排序取排名第 1 名買進，T+1 開盤進、T+${CONFIG.holdDays} 期間取 max(high) 算「3 天內最大漲幅」，無停損。產線實際門檻：多頭軌要求 step1 通過、反轉軌與戰法軌書本本意全市場掃。前 ${CONFIG.topNTurnover} 大成交額過濾對齊產線 ScanPipeline。`);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## v12 策略對照（書本根據）');
  lines.push('');
  lines.push('| 策略 | 軌道 | 書本根據 |');
  lines.push('|---|---|---|');
  for (const L of CONFIG.letters) {
    lines.push(`| **${nameOf(L)}** | ${TRACK_LABEL[L]} | 朱家泓 五步法／飆股／寶典 |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## 主排行（依「3 天內最大漲幅平均」排序，top 25）');
  lines.push('');
  lines.push('| # | 策略 | 排序 | 軌道 | 買進次數 | 3天內最大漲幅均% | 中位% | T+3收盤均% | 漲>0% | 漲≥5%命中% | 最深low均% | 等級 |');
  lines.push('|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|:--:|');
  const ranked = [...stats].filter(s => s.picks >= 5).sort((a, b) => b.avgMaxGain - a.avgMaxGain);
  ranked.slice(0, 25).forEach((s, i) => {
    lines.push(`| ${i + 1} | **${nameOf(s.letter)}** | ${s.sort} | ${s.track} | ${s.picks} | ${fmtSigned(s.avgMaxGain)} | ${fmtSigned(s.medMaxGain)} | ${fmtSigned(s.avgD3Close)} | ${s.winRateMaxGain.toFixed(1)} | ${s.hitRate5pct.toFixed(1)} | ${fmtSigned(s.worstLowAvg)} | **${s.grade}** |`);
  });
  lines.push('');

  lines.push('## 完整矩陣（策略 × 排序 → 3 天內最大漲幅 平均%）');
  lines.push('');
  const header = ['策略 \\ 排序', ...CONFIG.sorts].join(' | ');
  lines.push(`| ${header} |`);
  lines.push(`|${':---:|'.repeat(CONFIG.sorts.length + 1)}`);
  for (const L of CONFIG.letters) {
    const cells = CONFIG.sorts.map(S => {
      const s = stats.find(x => x.letter === L && x.sort === S);
      if (!s || s.picks < 5) return '_n/a_';
      return `${fmtSigned(s.avgMaxGain)} (n=${s.picks})`;
    });
    lines.push(`| **${nameOf(L)}** | ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## 完整矩陣（策略 × 排序 → 勝率%）');
  lines.push('');
  lines.push(`| ${header} |`);
  lines.push(`|${':---:|'.repeat(CONFIG.sorts.length + 1)}`);
  for (const L of CONFIG.letters) {
    const cells = CONFIG.sorts.map(S => {
      const s = stats.find(x => x.letter === L && x.sort === S);
      if (!s || s.picks < 5) return '_n/a_';
      return `${s.winRateMaxGain.toFixed(0)}% (n=${s.picks})`;
    });
    lines.push(`| **${nameOf(L)}** | ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## 前 3 名組合的實際每日選股（最多 50 筆）');
  lines.push('');
  ranked.slice(0, 3).forEach((s, i) => {
    lines.push(`### #${i + 1}: ${nameOf(s.letter)} × ${s.sort}（3 天內最大漲幅 平均 ${fmtSigned(s.avgMaxGain)}%、勝率 ${s.winRateMaxGain}%）`);
    lines.push('');
    lines.push('| 市場 | 日期 | 代號 | 名稱 | 3 天內最大漲幅% | T+3 收盤% | 最深low% |');
    lines.push('|---|---|---|---|---:|---:|---:|');
    const picks = topPicks.get(`${s.letter}|${s.sort}`) ?? [];
    for (const p of picks.slice(0, 50)) {
      if (p.maxGain == null) continue;
      lines.push(`| ${p.market} | ${p.date} | ${p.symbol} | ${p.name} | ${fmtSigned(p.maxGain)} | ${fmtSigned(p.d3CloseReturn ?? 0)} | ${fmtSigned(p.worstLow ?? 0)} |`);
    }
    lines.push('');
  });

  lines.push('---');
  lines.push('');
  lines.push('## 風險與限制');
  lines.push('');
  lines.push('1. **本回測用 v12 detector 重跑 L1 歷史 K 線**（非讀 scan blob），確保整個 2026-01-01 ~ 2026-05-12 都是 v12 一致定義。');
  lines.push('2. **3 天內最大漲幅是 high 觸頂**：實際吃到要在 3 天內掛單，放著不動只能拿 T+3 收盤。');
  lines.push('3. **Survivorship bias**：已退市股不在 L1 candles。');
  lines.push('4. **前 500 大成交額過濾**對齊產線（避免散戶買不到的冷門股）。');
  lines.push('5. **sixConditionsScore 用代理值**：v12StockEvaluator 不直接輸出整數 0-6 分數，本腳本用 step1 三項組合推算。實際產線 score 可能略有差異。');
  lines.push('6. **MTF 排序退回六條件**：v12StockEvaluator 不算 MTF，所以 MTF 排序欄位等同六條件。');

  fs.writeFileSync(OUT_MD, lines.join('\n'));
  console.log(`  寫入 ${path.relative(process.cwd(), OUT_MD)}`);
}

// ════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════

function main(): void {
  const startTime = Date.now();
  console.log('\n  ═══ v12 全期間回測 ═══');
  console.log(`  期間：${CONFIG.startDate} → ${CONFIG.endDate}`);
  console.log(`  策略：${CONFIG.letters.length} 個（v12 全字母）`);
  console.log(`  排序：${CONFIG.sorts.length} 種`);
  console.log('');

  console.log('  載入 L1 candles + 計算指標...');
  const twStocks = loadMarketStocks('TW');
  const cnStocks = loadMarketStocks('CN');

  console.log('  載入大盤指數...');
  const twIndex = loadIndexCandles('TW');
  const cnIndex = loadIndexCandles('CN');
  console.log(`    TW index: ${twIndex.length} 根　CN index: ${cnIndex.length} 根`);

  console.log('\n  跑 v12 detector...');
  const twEvents = collectEvents('TW', twStocks, twIndex);
  console.log(`    TW events: ${twEvents.length} 筆`);
  const cnEvents = collectEvents('CN', cnStocks, cnIndex);
  console.log(`    CN events: ${cnEvents.length} 筆`);

  const allEvents = [...twEvents, ...cnEvents];
  console.log(`  合計事件：${allEvents.length} 筆`);

  // 算交易日數
  const daysTW = new Set(twEvents.map(e => e.date)).size;
  const daysCN = new Set(cnEvents.map(e => e.date)).size;

  // 建 stocksByKey 給 computeForward 用
  const stocksByKey = new Map<string, StockData>();
  for (const s of [...twStocks, ...cnStocks]) stocksByKey.set(`${s.market}|${s.symbol}`, s);

  console.log('\n  跑網格 (letter × sort × day)...');
  const cells = runGrid(allEvents, stocksByKey);
  const stats = cells.map(summarize);
  const topPicks = new Map<string, Pick[]>();
  for (const c of cells) topPicks.set(`${c.letter}|${c.sort}`, c.picks);

  const ranked = stats.filter(s => s.picks >= 5).sort((a, b) => b.avgMaxGain - a.avgMaxGain);
  console.log('\n  ═══════════ Top 15（依 3 天內最大漲幅平均）═══════════');
  console.log('  #   策略              排序          軌道   picks  maxG均   勝率%   ≥5%命中   等級');
  console.log('  ─── ───────────────── ──────────── ────── ────── ──────── ─────── ─────── ──────');
  ranked.slice(0, 15).forEach((s, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}.  ${(nameOf(s.letter) + '                ').slice(0, 16)}  ` +
      `${(s.sort + '            ').slice(0, 12)} ${(s.track + '    ').slice(0, 4)}   ` +
      `${String(s.picks).padStart(4)}  ${fmtSigned(s.avgMaxGain).padStart(7)}%  ` +
      `${s.winRateMaxGain.toFixed(1).padStart(5)}%   ${s.hitRate5pct.toFixed(1).padStart(5)}%   ${s.grade}`
    );
  });
  console.log('');

  writeJson({
    generatedAt: new Date().toISOString(),
    config: CONFIG,
    meta: { eventsCount: allEvents.length, daysTW, daysCN },
    stats,
  });
  writeMarkdown(stats, topPicks, { eventsCount: allEvents.length, daysTW, daysCN });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  完成（${elapsed} 秒）\n`);
}

main();
