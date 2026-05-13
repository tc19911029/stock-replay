/**
 * Top-1 × d3 maxGain 回測
 *
 * 模擬：每天從 [策略字母 L] 的命中清單中、用 [排序方式 S] 挑出排名第 1 名
 * 那檔股票，買進後算「3 個交易日內的最大漲幅 maxGain」。
 *
 * 跑網格 (L, S)，找出最會挑「3 天內會漲」股票的組合。
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=4096" npx tsx scripts/backtest-top1-d3.ts
 *
 * 輸出：
 *   data/backtest_top1_d3.json
 *   data/backtest-output/top1-d3-{YYYY-MM-DD}.md
 */

import fs from 'fs';
import path from 'path';

// ════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════

const CONFIG = {
  cutoffDate: '2026-04-21',
  holdDays: 3,                     // 持有 3 個交易日
  letters: ['B','C','D','E','F','G','H','I','M','N','O','P','Q'] as const,
  sorts: ['漲幅', '六條件', 'MTF', '成交額排名', '面板對齊'] as const,
  minPicksForGrade: 15,            // 至少 15 個交易日的 pick 才評等級
} as const;

const TRACK_LABEL: Record<string, string> = {
  B: '多頭', C: '多頭', E: '多頭', M: '多頭', P: '多頭',
  G: '多頭標籤', H: '多頭標籤', I: '多頭標籤',
  D: '反轉', F: '反轉', N: '反轉', O: '反轉',
  Q: '戰法',
};

const STRATEGY_NAME: Record<string, string> = {
  B: '回後買上漲',
  C: '盤整突破',
  D: '一字底突破',
  E: '缺口進場',
  F: 'V 形反轉',
  G: 'ABC 突破',
  H: '突破大量黑 K',
  I: 'K 線橫盤突破',
  M: '突破上升軌道線',
  N: '型態確認',
  O: '打底完成',
  P: '高檔拉回',
  Q: '三均線戰法',
};

const BULLISH_REQUIRES_STEP1 = new Set(['B', 'C', 'E', 'M', 'P']);

const ROOT = path.join(process.cwd(), 'data');
const CANDLE_ROOT = path.join(ROOT, 'candles');
const OUT_JSON = path.join(ROOT, 'backtest_top1_d3.json');
const OUT_MD_DIR = path.join(ROOT, 'backtest-output');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_MD = path.join(OUT_MD_DIR, `top1-d3-${TODAY}.md`);

// ════════════════════════════════════════════════════════════════
// 型別
// ════════════════════════════════════════════════════════════════

interface ScanRow {
  symbol: string;
  name?: string;
  matchedMethods?: string[];
  sixConditionsScore?: number;
  changePercent?: number;
  mtfScore?: number;
  turnoverRank?: number;
  longProhibitionsReasons?: string[];
}

interface CandidateEvent {
  market: 'TW' | 'CN';
  date: string;
  symbol: string;
  name: string;
  matchedMethods: Set<string>;
  sixConditionsScore: number;
  changePercent: number;
  mtfScore: number;
  turnoverRank: number;
  step1Passed: boolean;
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
  winRateMaxGain: number;   // % of picks where maxGain > 0
  winRateD3Close: number;   // % of picks where d3Close > 0
  hitRate5pct: number;      // % of picks where maxGain >= 5%
  worstLowAvg: number;      // 平均最深回檔
  grade: 'A' | 'B' | 'C' | 'D' | 'tentative' | 'low-sample';
}

// ════════════════════════════════════════════════════════════════
// 載入 scan blob → 每日候選池
// ════════════════════════════════════════════════════════════════

function loadDailyCandidates(): Map<string, CandidateEvent> {
  // key = market|date|symbol → merged event
  const events = new Map<string, CandidateEvent>();
  const files = fs.readdirSync(ROOT).filter(f =>
    /^scan-(TW|CN)-long-([A-Q]|daily)-\d{4}-\d{2}-\d{2}\.json$/.test(f)
  );
  let filesScanned = 0;

  for (const f of files) {
    const m = f.match(/^scan-(TW|CN)-long-([A-Q]|daily)-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const market = m[1] as 'TW' | 'CN';
    const date = m[3];
    if (date < CONFIG.cutoffDate) continue;

    let raw: { results?: ScanRow[]; step1Filter?: string };
    try { raw = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { continue; }
    filesScanned++;

    const fileEnforcesStep1 = m[2] === 'daily' || raw.step1Filter === 'applied';

    for (const r of raw.results ?? []) {
      const key = `${market}|${date}|${r.symbol}`;
      let ev = events.get(key);
      if (!ev) {
        ev = {
          market, date, symbol: r.symbol,
          name: r.name ?? r.symbol,
          matchedMethods: new Set<string>(),
          sixConditionsScore: r.sixConditionsScore ?? 0,
          changePercent: r.changePercent ?? 0,
          mtfScore: r.mtfScore ?? 0,
          turnoverRank: r.turnoverRank ?? 999_999,
          step1Passed: false,
        };
        events.set(key, ev);
      }
      for (const x of r.matchedMethods ?? []) ev.matchedMethods.add(x);
      if (fileEnforcesStep1) ev.step1Passed = true;
      if ((r.sixConditionsScore ?? 0) > ev.sixConditionsScore) ev.sixConditionsScore = r.sixConditionsScore ?? 0;
      // 對於同一 (date, symbol)，changePercent/mtfScore/turnoverRank 應該相同；取第一個非零
      if (!ev.changePercent && r.changePercent != null) ev.changePercent = r.changePercent;
      if (!ev.mtfScore && r.mtfScore != null) ev.mtfScore = r.mtfScore;
      if (ev.turnoverRank === 999_999 && r.turnoverRank != null) ev.turnoverRank = r.turnoverRank;
      if (r.name && ev.name === ev.symbol) ev.name = r.name;
    }
  }
  process.stdout.write(`  scan blob 載入：${filesScanned} 檔案 → ${events.size} 個 unique event\n`);
  return events;
}

// ════════════════════════════════════════════════════════════════
// L1 candles
// ════════════════════════════════════════════════════════════════

interface CandleLite { date: string; open: number; close: number; high: number; low: number; }

const candleCache = new Map<string, CandleLite[] | null>();

function loadCandles(market: 'TW' | 'CN', symbol: string): CandleLite[] | null {
  const key = `${market}|${symbol}`;
  if (candleCache.has(key)) return candleCache.get(key)!;
  const file = path.join(CANDLE_ROOT, market, `${symbol}.json`);
  if (!fs.existsSync(file)) { candleCache.set(key, null); return null; }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rawCandles = Array.isArray(raw) ? raw : (raw.candles ?? []);
    const norm: CandleLite[] = rawCandles
      .map((c: { date?: string; open?: number; close?: number; high?: number; low?: number }) => ({
        date: (c.date ?? '').slice(0, 10),
        open: Number(c.open) || 0,
        close: Number(c.close) || 0,
        high: Number(c.high) || 0,
        low: Number(c.low) || 0,
      }))
      .filter((c: CandleLite) => c.date && c.close > 0);
    candleCache.set(key, norm);
    return norm;
  } catch {
    candleCache.set(key, null);
    return null;
  }
}

/** T+1 open 為進場價，T+1..T+H 期間 high 的最大值算 maxGain，T+H close 算 d3CloseReturn */
function computeForward(market: 'TW' | 'CN', symbol: string, t0Date: string, holdDays: number): { maxGain: number | null; d3Close: number | null; worstLow: number | null } {
  const candles = loadCandles(market, symbol);
  if (!candles?.length) return { maxGain: null, d3Close: null, worstLow: null };
  const t0 = candles.findIndex(c => c.date === t0Date);
  if (t0 < 0 || t0 + holdDays >= candles.length) return { maxGain: null, d3Close: null, worstLow: null };
  const entry = candles[t0 + 1].open;
  if (entry <= 0) return { maxGain: null, d3Close: null, worstLow: null };
  let maxHigh = -Infinity, minLow = Infinity;
  for (let i = t0 + 1; i <= t0 + holdDays; i++) {
    if (candles[i].high > maxHigh) maxHigh = candles[i].high;
    if (candles[i].low < minLow) minLow = candles[i].low;
  }
  const exitClose = candles[t0 + holdDays].close;
  return {
    maxGain: (maxHigh - entry) / entry * 100,
    d3Close: (exitClose - entry) / entry * 100,
    worstLow: (minLow - entry) / entry * 100,
  };
}

// ════════════════════════════════════════════════════════════════
// 排序器（5 種）
// ════════════════════════════════════════════════════════════════

type SortKey = (e: CandidateEvent) => number;

const SORT_FNS: Record<typeof CONFIG.sorts[number], SortKey> = {
  // 主鍵漲幅大→小
  '漲幅': e => e.changePercent,
  // 六條件分數高→低（含小數對齊 changePercent 當次鍵防同分）
  '六條件': e => e.sixConditionsScore * 100 + e.changePercent / 100,
  // MTF 分數高→低（次鍵漲幅）
  'MTF': e => e.mtfScore * 100 + e.changePercent / 100,
  // 成交額排名小→大（rank 1 是成交額第 1）；轉成 score = -rank 讓「大者」勝出
  '成交額排名': e => -e.turnoverRank,
  // 面板對齊：主鍵漲幅、次鍵六條件 — 對齊 lib/selection/applyPanelFilter panelSortKey
  '面板對齊': e => e.changePercent * 1000 + e.sixConditionsScore,
};

// ════════════════════════════════════════════════════════════════
// 主迴圈：對 (letter, sort, market, date) 取 top-1
// ════════════════════════════════════════════════════════════════

interface CellRun {
  letter: string;
  sort: string;
  picks: Pick[];
}

function passesProductionGate(letter: string, e: CandidateEvent): boolean {
  if (BULLISH_REQUIRES_STEP1.has(letter)) return e.step1Passed && e.sixConditionsScore >= 5;
  return true;
}

function runGrid(events: Map<string, CandidateEvent>): CellRun[] {
  // 先 group by (market, date)
  const byDay = new Map<string, CandidateEvent[]>();
  for (const e of events.values()) {
    const key = `${e.market}|${e.date}`;
    const arr = byDay.get(key) ?? [];
    arr.push(e);
    byDay.set(key, arr);
  }

  const cells: CellRun[] = [];
  for (const letter of CONFIG.letters) {
    for (const sort of CONFIG.sorts) {
      const sortFn = SORT_FNS[sort];
      const picks: Pick[] = [];
      for (const [, dayEvents] of byDay) {
        const candidates = dayEvents.filter(e =>
          e.matchedMethods.has(letter) && passesProductionGate(letter, e)
        );
        if (!candidates.length) continue;
        candidates.sort((a, b) => sortFn(b) - sortFn(a));
        const top = candidates[0];
        const fwd = computeForward(top.market, top.symbol, top.date, CONFIG.holdDays);
        picks.push({
          market: top.market,
          date: top.date,
          symbol: top.symbol,
          name: top.name,
          maxGain: fwd.maxGain,
          d3CloseReturn: fwd.d3Close,
          worstLow: fwd.worstLow,
        });
      }
      cells.push({ letter, sort, picks });
    }
  }
  return cells;
}

// ════════════════════════════════════════════════════════════════
// 統計
// ════════════════════════════════════════════════════════════════

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round(x: number, p = 2): number {
  const f = Math.pow(10, p);
  return Math.round(x * f) / f;
}

function gradeCell(picks: number, avgMaxGain: number, winRate: number): CellStats['grade'] {
  if (picks < CONFIG.minPicksForGrade) return picks < 5 ? 'low-sample' : 'tentative';
  if (avgMaxGain >= 6 && winRate >= 75) return 'A';
  if (avgMaxGain >= 4 && winRate >= 65) return 'B';
  if (avgMaxGain >= 2 && winRate >= 55) return 'C';
  return 'D';
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

function writeJson(payload: object): void {
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
  console.log(`  寫入 ${path.relative(process.cwd(), OUT_JSON)}`);
}

function fmtSigned(x: number): string {
  return (x >= 0 ? '+' : '') + x.toFixed(2);
}

function writeMarkdown(stats: CellStats[], topPicks: Map<string, Pick[]>): void {
  if (!fs.existsSync(OUT_MD_DIR)) fs.mkdirSync(OUT_MD_DIR, { recursive: true });
  const nameOf = (L: string) => STRATEGY_NAME[L] ?? L;
  const lines: string[] = [];
  lines.push(`# 每日取第一名、3 天內最大漲幅 回測報告`);
  lines.push('');
  lines.push(`產出時間：${new Date().toISOString()}　|　Cutoff: ${CONFIG.cutoffDate} 以後　|　持有：${CONFIG.holdDays} 個交易日`);
  lines.push('');
  lines.push(`規則：每天從每個策略的命中清單中，依排序取排名第 1 名買進，T+1 開盤進、T+${CONFIG.holdDays} 期間取 max(high) 算「3 天內最大漲幅」，無停損。`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 策略對照（書本根據）');
  lines.push('');
  lines.push('| 策略 | 軌道 | 書本根據 |');
  lines.push('|---|---|---|');
  for (const L of CONFIG.letters) {
    lines.push(`| **${nameOf(L)}** | ${TRACK_LABEL[L]} | 朱家泓 五步法／飆股／寶典 |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 主排行（依「3 天內最大漲幅平均」排序，top 20）');
  lines.push('');
  lines.push('| # | 策略 | 排序 | 軌道 | 買進次數 | 3 天內最大漲幅 平均% | 中位% | T+3 收盤均% | 漲>0% | 漲≥5%命中% | 最深low均% | 等級 |');
  lines.push('|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|:--:|');
  const ranked = [...stats].filter(s => s.picks >= 5).sort((a, b) => b.avgMaxGain - a.avgMaxGain);
  ranked.slice(0, 20).forEach((s, i) => {
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

  lines.push('## 完整矩陣（策略 × 排序 → 漲 > 0 的勝率%）');
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

  // top 5 cell picks
  lines.push('## 前 3 名組合的實際每日選股');
  lines.push('');
  ranked.slice(0, 3).forEach((s, i) => {
    lines.push(`### #${i + 1}: ${nameOf(s.letter)} × ${s.sort}（3 天內最大漲幅 平均 ${fmtSigned(s.avgMaxGain)}%、勝率 ${s.winRateMaxGain}%）`);
    lines.push('');
    lines.push('| 市場 | 日期 | 代號 | 名稱 | 3 天內最大漲幅% | T+3 收盤% | 最深low% |');
    lines.push('|---|---|---|---|---:|---:|---:|');
    const picks = topPicks.get(`${s.letter}|${s.sort}`) ?? [];
    for (const p of picks.slice(0, 25)) {
      if (p.maxGain == null) continue;
      lines.push(`| ${p.market} | ${p.date} | ${p.symbol} | ${p.name} | ${fmtSigned(p.maxGain)} | ${fmtSigned(p.d3CloseReturn ?? 0)} | ${fmtSigned(p.worstLow ?? 0)} |`);
    }
    lines.push('');
  });

  lines.push('---');
  lines.push('');
  lines.push('## 風險與限制');
  lines.push('');
  lines.push('1. **小樣本警告**：本回測只用 2026-04-21 起的 scan blob，TW+CN 共約 14 個交易日 × 兩市場 = 約 28 個 day-market；每個 (字母 × 排序) 組合最多 28 個 pick。標 `tentative` 的 cell 是 5–14 picks。');
  lines.push('2. **不加停損**：報原始 T+3 期間表現。如要加 −3% 停損，請改 CONFIG.holdDays 或在 computeForward 加 stop logic。');
  lines.push('3. **maxGain 是「3 天內任一天 high 觸頂」**：用戶若實際以收盤決策，可能抓不到此 max；參考「d3 收盤均」欄。');
  lines.push('4. **Survivorship bias**：已退市股不在 candles，可能略偏高。');
  lines.push('5. **沒考慮資金與重疊**：純統計每筆 picker 的表現，沒模擬「每日買 1 支但前一支還沒賣完」的資金限制。');

  fs.writeFileSync(OUT_MD, lines.join('\n'));
  console.log(`  寫入 ${path.relative(process.cwd(), OUT_MD)}`);
}

// ════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════

function main(): void {
  console.log('\n  載入 scan blob...');
  const events = loadDailyCandidates();

  console.log('  跑網格 (letter × sort × day)...');
  const cells = runGrid(events);

  console.log('  計算統計...');
  const stats = cells.map(summarize);
  const topPicks = new Map<string, Pick[]>();
  for (const c of cells) topPicks.set(`${c.letter}|${c.sort}`, c.picks);

  // 顯示前 15 排名
  const ranked = stats.filter(s => s.picks >= 5).sort((a, b) => b.avgMaxGain - a.avgMaxGain);
  console.log('\n  ═══════════ Top 15（依 maxGain 平均）═══════════');
  console.log('  #   字母  排序          軌道     picks  maxG均   勝率%  ≥5%命中  等級');
  console.log('  ─── ───── ──────────── ──────── ────── ──────── ────── ──────── ─────');
  ranked.slice(0, 15).forEach((s, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}.  ${s.letter}    ` +
      `${(s.sort + '          ').slice(0, 12)} ${(s.track + '      ').slice(0, 7)} ` +
      `${String(s.picks).padStart(4)}  ${fmtSigned(s.avgMaxGain).padStart(7)}%  ` +
      `${s.winRateMaxGain.toFixed(1).padStart(5)}%  ${s.hitRate5pct.toFixed(1).padStart(6)}%   ${s.grade}`
    );
  });
  console.log('');

  writeJson({
    generatedAt: new Date().toISOString(),
    cutoffDate: CONFIG.cutoffDate,
    holdDays: CONFIG.holdDays,
    letters: CONFIG.letters,
    sorts: CONFIG.sorts,
    totalCells: stats.length,
    stats,
  });
  writeMarkdown(stats, topPicks);
  console.log('\n  完成。\n');
}

main();
