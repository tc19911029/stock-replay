/**
 * Per-字母 d5 回測：從既有 scan blob + L1 candles 統計每個字母策略的
 * 5 日勝率、平均報酬、樣本數，並產出操作建議。
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=4096" npx tsx scripts/backtest-per-letter.ts
 *
 * 輸出：
 *   data/backtest_results_per_letter.json
 *   data/backtest-output/per-letter-{YYYY-MM-DD}.md
 */

import fs from 'fs';
import path from 'path';

// ════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════

const CONFIG = {
  cutoffDate: '2026-04-21',        // 規避 4/21 字母 rename
  minSampleForGrade: 100,
  letters: ['B','C','D','E','F','G','H','I','M','N','O','P','Q'] as const,
  stopLossPct: -3,                 // 書本 SOP 3% 停損 → 回測時 cap maxLoss
} as const;

const TRACK_LABEL: Record<string, string> = {
  B: '多頭軌', C: '多頭軌', E: '多頭軌', M: '多頭軌', P: '多頭軌',
  G: '多頭(標籤)', H: '多頭(標籤)', I: '多頭(標籤)',
  J: '多頭(別名)', K: '多頭(別名)', L: '多頭(別名)',
  D: '反轉軌', F: '反轉軌', N: '反轉軌', O: '反轉軌',
  Q: '戰法軌',
};

// 多頭軌字母在產線上必須過 Step 1（六條件 ≥ 5）
const BULLISH_REQUIRES_STEP1 = new Set(['B', 'C', 'E', 'M', 'P']);

const ROOT = path.join(process.cwd(), 'data');
const CANDLE_ROOT = path.join(ROOT, 'candles');
const OUT_JSON = path.join(ROOT, 'backtest_results_per_letter.json');
const OUT_MD_DIR = path.join(ROOT, 'backtest-output');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_MD = path.join(OUT_MD_DIR, `per-letter-${TODAY}.md`);

// ════════════════════════════════════════════════════════════════
// 型別
// ════════════════════════════════════════════════════════════════

interface ScanRow {
  symbol: string;
  matchedMethods?: string[];
  sixConditionsScore?: number;
  d5ReturnFromOpen?: number | null;
  d5Return?: number | null;
  maxGain?: number | null;
  maxLoss?: number | null;
  longProhibitionsReasons?: string[];
  nextOpenPrice?: number | null;
}

interface MasterEvent {
  market: 'TW' | 'CN';
  date: string;
  symbol: string;
  matchedMethods: Set<string>;
  sixConditionsScore: number;
  step1Passed: boolean;
  hasProhibitions: boolean;
  d5FromOpen: number | null;
  d5FromClose: number | null;
  maxGain: number | null;
  maxLoss: number | null;
  d5BackfilledFromL1: boolean;
}

interface LetterStats {
  letter: string;
  track: string;
  samples: number;
  samplesWithD5: number;
  step1PassRate: number;
  winRate: number;
  d5Avg: number;
  d5Median: number;
  d5StopLoss3pct: number;
  maxGainMedian: number;
  maxLossMedian: number;
  pureSamples: number;
  pureWinRate: number;
  pureD5Avg: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'tentative' | 'low-sample';
  advice: string;
}

interface PairStats {
  letters: string;
  samples: number;
  winRate: number;
  d5Avg: number;
  delta: number; // 共振 - 兩字母獨立平均
}

// ════════════════════════════════════════════════════════════════
// 載入 scan blob 並組 master event
// ════════════════════════════════════════════════════════════════

function loadAllEvents(): Map<string, MasterEvent> {
  const events = new Map<string, MasterEvent>();
  const files = fs.readdirSync(ROOT).filter(f =>
    /^scan-(TW|CN)-long-([A-Q]|daily)-\d{4}-\d{2}-\d{2}\.json$/.test(f)
  );
  let filesScanned = 0;
  let rowsScanned = 0;

  for (const f of files) {
    const m = f.match(/^scan-(TW|CN)-long-([A-Q]|daily)-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const market = m[1] as 'TW' | 'CN';
    const date = m[3];
    if (date < CONFIG.cutoffDate) continue;

    const parsed = readScanFile(path.join(ROOT, f));
    if (!parsed) continue;
    filesScanned++;

    // step1 來源判斷：
    // - daily-session 檔 = step1 池，所有 row 都過了
    // - per-letter 檔的 step1Filter='applied'（B/C/E/J/K/L/M/P 多頭軌），row 都過了
    // - per-letter 檔的 step1Filter='bypassed'（D/F/N/O/Q），不代表沒過、只是沒驗
    const isDailySession = m[2] === 'daily';
    const fileEnforcesStep1 = isDailySession || parsed.step1Filter === 'applied';

    for (const r of parsed.rows) {
      rowsScanned++;
      const key = `${market}|${date}|${r.symbol}`;
      let ev = events.get(key);
      if (!ev) {
        ev = {
          market, date, symbol: r.symbol,
          matchedMethods: new Set<string>(),
          sixConditionsScore: r.sixConditionsScore ?? 0,
          step1Passed: false,
          hasProhibitions: false,
          d5FromOpen: null, d5FromClose: null,
          maxGain: null, maxLoss: null,
          d5BackfilledFromL1: false,
        };
        events.set(key, ev);
      }
      for (const x of r.matchedMethods ?? []) ev.matchedMethods.add(x);
      if (fileEnforcesStep1) ev.step1Passed = true;
      if ((r.longProhibitionsReasons ?? []).length > 0) ev.hasProhibitions = true;
      if (r.d5ReturnFromOpen != null && ev.d5FromOpen == null) ev.d5FromOpen = r.d5ReturnFromOpen;
      if (r.d5Return != null && ev.d5FromClose == null) ev.d5FromClose = r.d5Return;
      if (r.maxGain != null && ev.maxGain == null) ev.maxGain = r.maxGain;
      if (r.maxLoss != null && ev.maxLoss == null) ev.maxLoss = r.maxLoss;
      if ((r.sixConditionsScore ?? 0) > ev.sixConditionsScore) {
        ev.sixConditionsScore = r.sixConditionsScore ?? 0;
      }
    }
  }
  process.stdout.write(`  scan blob 載入：${filesScanned} 檔案、${rowsScanned} rows → ${events.size} 個 unique event\n`);
  return events;
}

function readScanFile(file: string): { rows: ScanRow[]; step1Filter: string } | null {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { rows: (d.results ?? []) as ScanRow[], step1Filter: d.step1Filter ?? '' };
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// L1 candles 載入 + d5 回填
// ════════════════════════════════════════════════════════════════

interface CandleLite { date: string; open: number; close: number; high: number; low: number; }

const candleCache = new Map<string, CandleLite[] | null>();

function loadCandles(market: 'TW' | 'CN', symbol: string): CandleLite[] | null {
  const key = `${market}|${symbol}`;
  if (candleCache.has(key)) return candleCache.get(key)!;
  const file = path.join(CANDLE_ROOT, market, `${symbol}.json`);
  if (!fs.existsSync(file)) {
    candleCache.set(key, null);
    return null;
  }
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

function backfillD5FromL1(ev: MasterEvent): void {
  if (ev.d5FromOpen != null && ev.d5FromClose != null) return;
  const candles = loadCandles(ev.market, ev.symbol);
  if (!candles || candles.length < 7) return;
  const t0 = candles.findIndex(c => c.date === ev.date);
  if (t0 < 0 || t0 + 5 >= candles.length) return;
  const t0Close = candles[t0].close;
  const t1Open = candles[t0 + 1].open;
  const t5Close = candles[t0 + 5].close;
  if (ev.d5FromOpen == null && t1Open > 0) {
    ev.d5FromOpen = (t5Close - t1Open) / t1Open * 100;
    ev.d5BackfilledFromL1 = true;
  }
  if (ev.d5FromClose == null && t0Close > 0) {
    ev.d5FromClose = (t5Close - t0Close) / t0Close * 100;
  }
  if ((ev.maxGain == null || ev.maxLoss == null) && t1Open > 0) {
    let mg = -Infinity, ml = Infinity;
    for (let i = t0 + 1; i <= Math.min(t0 + 10, candles.length - 1); i++) {
      const hi = (candles[i].high - t1Open) / t1Open * 100;
      const lo = (candles[i].low - t1Open) / t1Open * 100;
      if (hi > mg) mg = hi;
      if (lo < ml) ml = lo;
    }
    if (ev.maxGain == null && mg > -Infinity) ev.maxGain = mg;
    if (ev.maxLoss == null && ml < Infinity) ev.maxLoss = ml;
  }
}

// ════════════════════════════════════════════════════════════════
// 統計
// ════════════════════════════════════════════════════════════════

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function gradeOf(samples: number, winRate: number, d5avg: number): { grade: LetterStats['grade']; advice: string } {
  if (samples < 30) return { grade: 'low-sample', advice: '樣本 < 30，不評等級' };
  let base: 'A' | 'B' | 'C' | 'D';
  if (winRate >= 55 && d5avg >= 1.5) base = 'A';
  else if (winRate >= 52 && d5avg >= 0.5) base = 'B';
  else if (winRate < 50 || d5avg < -0.5) base = 'D';
  else base = 'C';

  let advice = '';
  if (base === 'A') advice = '表現良好，優先參考；若樣本還少可下調 threshold 增加觸發';
  else if (base === 'B') advice = '中性偏好，作為次要進場依據；建議配合 A 級字母共振才下單';
  else if (base === 'C') advice = '邊界表現，建議只在大盤多頭 + 共振 A/B 字母時參考';
  else advice = '表現差，建議調高 threshold 或關閉；若是反轉軌則保留但下單前手動 confirm';

  if (samples < CONFIG.minSampleForGrade) {
    return { grade: 'tentative', advice: `樣本 ${samples}（< ${CONFIG.minSampleForGrade}）暫估 ${base} 等級；${advice}` };
  }
  return { grade: base, advice };
}

function computeLetterStats(letter: string, events: MasterEvent[]): LetterStats {
  // 對齊產線：多頭軌 (B/C/E/M/P) 必須 step1 通過（sixConditionsScore ≥ 5）
  // 反轉軌 (D/F/N/O) 與戰法軌 (Q) 不要求過 Step 1（書本本意）
  // G/H/I/J/K/L 為多頭標籤，per-letter scan endpoint 沒強制 Step 1，與「all annotations」一致
  const passesProductionGate = (e: MasterEvent): boolean => {
    if (BULLISH_REQUIRES_STEP1.has(letter)) return e.sixConditionsScore >= 5;
    return true;
  };
  const samples = events.filter(e => e.matchedMethods.has(letter) && passesProductionGate(e));
  const withD5 = samples.filter(e => e.d5FromOpen != null);
  const d5List = withD5.map(e => e.d5FromOpen as number);
  const wins = d5List.filter(x => x > 0).length;
  const winRate = d5List.length ? wins / d5List.length * 100 : 0;
  const d5Avg = mean(d5List);
  const d5Med = median(d5List);
  // 3% 停損後的實際報酬：若 maxLoss ≤ -3 → -3，否則 d5
  const stopLossList = withD5.map(e => {
    if (e.maxLoss != null && e.maxLoss <= CONFIG.stopLossPct) return CONFIG.stopLossPct;
    return e.d5FromOpen as number;
  });
  const d5StopLoss = mean(stopLossList);
  const maxGainList = samples.map(e => e.maxGain).filter((x): x is number => x != null);
  const maxLossList = samples.map(e => e.maxLoss).filter((x): x is number => x != null);
  const step1Count = samples.filter(e => e.step1Passed).length;
  const step1PassRate = samples.length ? step1Count / samples.length * 100 : 0;

  // pure-letter：matchedMethods 只含該字母（去掉 A，因 A 是 Step 1 標籤不是進場戰法）
  const pure = withD5.filter(e => {
    const others = [...e.matchedMethods].filter(m => m !== 'A' && m !== letter);
    return others.length === 0;
  });
  const pureD5 = pure.map(e => e.d5FromOpen as number);
  const pureWinRate = pureD5.length ? pureD5.filter(x => x > 0).length / pureD5.length * 100 : 0;
  const pureD5Avg = mean(pureD5);

  const g = gradeOf(d5List.length, winRate, d5Avg);

  return {
    letter,
    track: TRACK_LABEL[letter] ?? '-',
    samples: samples.length,
    samplesWithD5: d5List.length,
    step1PassRate: round(step1PassRate, 1),
    winRate: round(winRate, 1),
    d5Avg: round(d5Avg, 2),
    d5Median: round(d5Med, 2),
    d5StopLoss3pct: round(d5StopLoss, 2),
    maxGainMedian: round(median(maxGainList), 2),
    maxLossMedian: round(median(maxLossList), 2),
    pureSamples: pureD5.length,
    pureWinRate: round(pureWinRate, 1),
    pureD5Avg: round(pureD5Avg, 2),
    grade: g.grade,
    advice: g.advice,
  };
}

function round(x: number, p: number): number {
  const f = Math.pow(10, p);
  return Math.round(x * f) / f;
}

function computeCoOccurrence(events: MasterEvent[], letterStats: LetterStats[]): PairStats[] {
  const byLetter = new Map(letterStats.map(s => [s.letter, s]));
  const pairs = new Map<string, { d5: number[]; samples: number }>();
  for (const e of events) {
    if (e.d5FromOpen == null) continue;
    const ms = [...e.matchedMethods].filter(m => CONFIG.letters.includes(m as typeof CONFIG.letters[number])).sort();
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const key = `${ms[i]}+${ms[j]}`;
        const slot = pairs.get(key) ?? { d5: [], samples: 0 };
        slot.d5.push(e.d5FromOpen);
        slot.samples++;
        pairs.set(key, slot);
      }
    }
  }
  const out: PairStats[] = [];
  for (const [k, v] of pairs) {
    if (v.samples < 30) continue;
    const [a, b] = k.split('+');
    const winRate = v.d5.filter(x => x > 0).length / v.d5.length * 100;
    const d5Avg = mean(v.d5);
    const aAvg = byLetter.get(a)?.d5Avg ?? 0;
    const bAvg = byLetter.get(b)?.d5Avg ?? 0;
    const delta = d5Avg - (aAvg + bAvg) / 2;
    out.push({
      letters: k,
      samples: v.samples,
      winRate: round(winRate, 1),
      d5Avg: round(d5Avg, 2),
      delta: round(delta, 2),
    });
  }
  return out.sort((a, b) => b.d5Avg - a.d5Avg);
}

// ════════════════════════════════════════════════════════════════
// 報告輸出
// ════════════════════════════════════════════════════════════════

interface ReportPayload {
  generatedAt: string;
  cutoffDate: string;
  totalEvents: number;
  eventsWithD5: number;
  l1Backfilled: number;
  letterStats: LetterStats[];
  coOccurrence: PairStats[];
}

function writeJson(payload: ReportPayload): void {
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
  console.log(`  寫入 ${path.relative(process.cwd(), OUT_JSON)}`);
}

function fmt(x: number, sign = false): string {
  const s = x >= 0 && sign ? '+' : '';
  return `${s}${x.toFixed(2)}`;
}

function writeMarkdown(payload: ReportPayload): void {
  if (!fs.existsSync(OUT_MD_DIR)) fs.mkdirSync(OUT_MD_DIR, { recursive: true });
  const lines: string[] = [];
  lines.push(`# Per-字母 d5 回測報告`);
  lines.push('');
  lines.push(`產出時間：${payload.generatedAt}　|　Cutoff: ${payload.cutoffDate} 以後　|　樣本來源：data/scan-*-long-*.json + L1 candles`);
  lines.push('');
  lines.push(`Master event 總計：**${payload.totalEvents}** 筆，其中 **${payload.eventsWithD5}** 筆有 d5 數據（${payload.l1Backfilled} 筆從 L1 補算）。`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 字母績效對照表（d5 = 5 個交易日，T+1 開盤進、T+5 收盤出）');
  lines.push('');
  lines.push('| 字母 | 軌道 | 樣本 | d5樣本 | 勝率% | d5平均% | d5中位% | maxGain中% | maxLoss中% | 3%停損後% | Step1% | 純樣本 | 純勝率% | 純d5% | 等級 |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:--:|');
  for (const s of payload.letterStats) {
    lines.push([
      `| **${s.letter}**`,
      s.track,
      s.samples,
      s.samplesWithD5,
      fmt(s.winRate),
      fmt(s.d5Avg, true),
      fmt(s.d5Median, true),
      fmt(s.maxGainMedian, true),
      fmt(s.maxLossMedian, true),
      fmt(s.d5StopLoss3pct, true),
      fmt(s.step1PassRate),
      s.pureSamples,
      fmt(s.pureWinRate),
      fmt(s.pureD5Avg, true),
      `**${s.grade}** |`,
    ].join(' | '));
  }
  lines.push('');
  lines.push('### 經營建議');
  lines.push('');
  for (const s of payload.letterStats) {
    lines.push(`- **${s.letter}（${s.track}）** [${s.grade}]：${s.advice}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 共振分析（兩字母同時命中、樣本 ≥ 30）');
  lines.push('');
  lines.push('Δ = 共振 d5 平均 − 兩字母單獨平均的均值；Δ > 0 表共振有 alpha。');
  lines.push('');
  if (payload.coOccurrence.length === 0) {
    lines.push('_目前共振樣本不足，全部 < 30 筆。_');
  } else {
    lines.push('| 組合 | 樣本 | 勝率% | d5平均% | Δ vs 獨立 |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const p of payload.coOccurrence.slice(0, 25)) {
      lines.push(`| ${p.letters} | ${p.samples} | ${fmt(p.winRate)} | ${fmt(p.d5Avg, true)} | ${fmt(p.delta, true)} |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 風險與邊界（必讀）');
  lines.push('');
  lines.push('1. **樣本不足**：M/N/O/P/Q 上線約 1 個月，樣本約 30–1500 筆；標 `tentative` 的字母結論暫時參考、需 1-2 月後再驗。');
  lines.push('2. **Survivorship bias**：本回測讀 `data/candles/` 現存股票，已退市股不在內 → 勝率可能略偏高。');
  lines.push('3. **停牌**：T0→T+5 中間若停牌、L1 candle 連續但跳日，d5 仍按 T+5 那根算（可能跨更多 calendar day）。');
  lines.push('4. **字母 rename cutoff**：嚴格 ≥ 2026-04-21 才納入，前期 B/C/D/E/F 定義不同。');
  lines.push('5. **多字母共現相關性**：`matchedMethods` 並列 → 同檔 d5 同時歸多字母 → 主表 `winRate` 是 any-letter（不純）；如要看獨立貢獻請看 `純` 三欄。');
  lines.push('6. **detector 版本漂移**：scan blob 是當下 detector 算的，自上線可能改過 threshold；本表反映「截至 2026-04-21 之後生產實際命中清單」。');
  lines.push('');
  fs.writeFileSync(OUT_MD, lines.join('\n'));
  console.log(`  寫入 ${path.relative(process.cwd(), OUT_MD)}`);
}

// ════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════

function main(): void {
  console.log('\n  載入 scan blob...');
  const eventMap = loadAllEvents();
  const allEvents = [...eventMap.values()];

  console.log('  從 L1 candles 補 d5 缺失...');
  let backfilled = 0;
  let attempted = 0;
  for (const e of allEvents) {
    if (e.d5FromOpen != null) continue;
    attempted++;
    backfillD5FromL1(e);
    if (e.d5BackfilledFromL1) backfilled++;
  }
  console.log(`  L1 補算：嘗試 ${attempted} 筆、成功 ${backfilled} 筆`);

  const eventsWithD5 = allEvents.filter(e => e.d5FromOpen != null).length;
  console.log(`  最終 d5 可用：${eventsWithD5} / ${allEvents.length}`);

  console.log('  計算每字母統計...');
  const letterStats = CONFIG.letters.map(L => computeLetterStats(L, allEvents));

  console.log('  計算共振...');
  const coOcc = computeCoOccurrence(allEvents, letterStats);

  const payload: ReportPayload = {
    generatedAt: new Date().toISOString(),
    cutoffDate: CONFIG.cutoffDate,
    totalEvents: allEvents.length,
    eventsWithD5,
    l1Backfilled: backfilled,
    letterStats,
    coOccurrence: coOcc,
  };

  console.log('\n  ═══════════ 主表 ═══════════');
  console.log('  字母 | 軌道       | 樣本 | d5樣本 | 勝率   | d5均  | 等級');
  console.log('  ─────┼────────────┼──────┼────────┼────────┼───────┼──────');
  for (const s of letterStats) {
    console.log(
      `   ${s.letter}   | ${(s.track + '     ').slice(0, 10)} | ` +
      `${String(s.samples).padStart(4)} | ${String(s.samplesWithD5).padStart(6)} | ` +
      `${(s.winRate.toFixed(1) + '%').padStart(6)} | ${(s.d5Avg >= 0 ? '+' : '') + s.d5Avg.toFixed(2)}% | ${s.grade}`
    );
  }
  console.log('');

  writeJson(payload);
  writeMarkdown(payload);
  console.log('\n  完成。\n');
}

main();
