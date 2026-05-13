/**
 * Limit-up vs scan-result audit
 *
 * 目的：每天列出「鎖漲停／鎖跌停股 vs scan 結果差集」，並對每檔差集股
 *      標註被擋的可能原因（L1 缺日 / 戒律暗示 / 趨勢狀態）。
 *
 * 設計動機：2026-05-13 發現 18 檔鎖漲停只有 2 檔進 daily 池子；其中
 *      2 檔（2377/6225）是 L1 缺 5/12 的真漏掃，14 檔可能是戒律合理排除。
 *      這個 audit 讓「合理排除 vs 真漏掃」明面化，讓使用者每天能審視。
 *
 * 用法：
 *   npx tsx scripts/audit-limit-up-vs-scan.ts
 *   npx tsx scripts/audit-limit-up-vs-scan.ts --market TW --date 2026-05-13
 *   npx tsx scripts/audit-limit-up-vs-scan.ts --json --write data/audit/limit-up-2026-05-13.json
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { getLastTradingDay } from '../lib/datasource/marketHours';

type Market = 'TW' | 'CN';

const LIMIT_THRESHOLD = 9.5; // |changePercent| ≥ 9.5 視為鎖漲跌停

interface IntradayQuote {
  symbol: string;
  name?: string;
  changePercent: number;
  close: number;
  prevClose?: number;
  volume?: number;
}

interface DiffEntry {
  symbol: string;
  name?: string;
  changePercent: number;
  reason: string;
}

interface AuditResult {
  market: Market;
  date: string;
  limitUpCount: number;
  limitDownCount: number;
  scanCoveredCount: number;
  diffCount: number;
  inScanLimit: string[];           // 鎖漲停股有進 scan 結果的
  diffStocks: DiffEntry[];          // 鎖漲停股沒進 scan 結果的，連帶被擋原因
}

function loadL2(market: Market, date: string): IntradayQuote[] {
  const f = path.join(process.cwd(), 'data', `intraday-${market}-${date}.json`);
  if (!existsSync(f)) return [];
  try {
    const d = JSON.parse(readFileSync(f, 'utf8')) as { quotes?: IntradayQuote[] };
    return d.quotes ?? [];
  } catch { return []; }
}

function loadScanResults(market: Market, date: string): Set<string> {
  const dataDir = path.join(process.cwd(), 'data');
  const letters = ['daily', 'B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'];
  const symbols = new Set<string>();
  for (const letter of letters) {
    const stable = path.join(dataDir, `scan-${market}-long-${letter}-${date}.json`);
    let file = existsSync(stable) ? stable : null;
    if (!file) {
      // fallback：找該日該字母最新的 intraday-XXXXXX 檔
      const pattern = new RegExp(`^scan-${market}-long-${letter}-${date}-intraday-`);
      const matched = readdirSync(dataDir).filter(f => pattern.test(f)).sort();
      if (matched.length > 0) file = path.join(dataDir, matched[matched.length - 1]);
    }
    if (!file) continue;
    try {
      const d = JSON.parse(readFileSync(file, 'utf8')) as { results?: Array<{ symbol?: string; code?: string }> };
      (d.results ?? []).forEach(r => {
        const s = (r.symbol ?? r.code ?? '').replace(/\.(TW|TWO|SS|SZ)$/i, '');
        if (s) symbols.add(s);
      });
    } catch { /* skip */ }
  }
  return symbols;
}

function checkL1HasDate(market: Market, code: string, date: string): boolean {
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  for (const suffix of (market === 'TW' ? ['.TW', '.TWO'] : ['.SS', '.SZ'])) {
    const f = path.join(dir, `${code}${suffix}.json`);
    if (!existsSync(f)) continue;
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8'));
      const candles = Array.isArray(raw) ? raw : (raw.candles || []);
      if (candles.length === 0) continue;
      return candles[candles.length - 1].date >= date;
    } catch { continue; }
  }
  return false;
}

/** 讀近 N 日 L1 K 線，給分類器當輸入 */
function readLastNCandles(market: Market, code: string, n: number): Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> {
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  for (const suffix of (market === 'TW' ? ['.TW', '.TWO'] : ['.SS', '.SZ'])) {
    const f = path.join(dir, `${code}${suffix}.json`);
    if (!existsSync(f)) continue;
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8'));
      const candles = Array.isArray(raw) ? raw : (raw.candles || []);
      return candles.slice(-n);
    } catch { /* continue */ }
  }
  return [];
}

function classifyReason(market: Market, q: IntradayQuote, date: string): string {
  // 用 lastTradingDay - 1 當判斷基準（今天盤中 L1 無封存正常）
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  const prevTradingDay = d.toISOString().split('T')[0];
  const code = q.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');

  if (!checkL1HasDate(market, code, prevTradingDay)) {
    return `L1 缺 ${prevTradingDay} → 精掃跳過（真漏掃 — 需 backfill）`;
  }

  if (q.changePercent <= -LIMIT_THRESHOLD) {
    return '鎖跌停 — 多頭掃描本就不收，預期排除';
  }

  // 鎖漲停 — 精細分類為三類淘汰法／戒律
  const recent = readLastNCandles(market, code, 10);
  if (recent.length < 5) {
    return '鎖漲停 — L1 不足無法分類';
  }

  // 條件 A：「連續一字漲停」— 近 7 日內出現過 O===H===L===C 且日漲幅 >=9%（吸籌完出貨型）
  const limitPct = q.prevClose && q.prevClose > 0 ? null : 0.098;
  const hasOnePieceUp = recent.slice(-7).some((c, i, arr) => {
    if (c.open !== c.high || c.high !== c.low || c.low !== c.close) return false;
    const prev = arr[i - 1] ?? recent[recent.indexOf(c) - 1];
    if (!prev) return false;
    return (c.close / prev.close - 1) >= (limitPct ?? 0.098);
  });

  // 條件 B：「高檔放量黑K」— 近 5 日內出現 close < open 且 volume > 前 5 日均量 *1.5 且當日漲跌 < 0
  const hasHighVolBlackK = (() => {
    const last5 = recent.slice(-5);
    for (let i = 1; i < last5.length; i++) {
      const c = last5[i];
      const prevSlice = recent.slice(-(10 - last5.length + i), -(last5.length - i));
      if (prevSlice.length < 5) continue;
      const avgVol = prevSlice.slice(-5).reduce((s, x) => s + x.volume, 0) / 5;
      if (c.close < c.open && c.volume > avgVol * 1.5) return true;
    }
    return false;
  })();

  // 條件 C：「7 日累漲 >20%」— 短線過熱戒律
  const accum7 = recent.length >= 7
    ? (recent[recent.length - 1].close / recent[recent.length - 7].close - 1) * 100
    : 0;
  const overheated = accum7 >= 20;

  const reasons: string[] = [];
  if (hasOnePieceUp) reasons.push('一字漲停吸籌完（淘汰法）');
  if (hasHighVolBlackK) reasons.push('高檔放量黑K（淘汰法）');
  if (overheated) reasons.push(`7 日累漲 ${accum7.toFixed(0)}%（戒律 9 短線過熱）`);

  if (reasons.length > 0) {
    return `鎖漲停 — ${reasons.join('、')}`;
  }
  return '鎖漲停 — 條件邊緣（六條件未過或 MTF 未過）— 需個別檢視';
}

async function auditMarket(market: Market, date: string): Promise<AuditResult> {
  const quotes = loadL2(market, date);
  if (quotes.length === 0) {
    return {
      market, date,
      limitUpCount: 0, limitDownCount: 0,
      scanCoveredCount: 0, diffCount: 0,
      inScanLimit: [], diffStocks: [],
    };
  }
  const limitUp = quotes.filter(q => q.changePercent >= LIMIT_THRESHOLD);
  const limitDown = quotes.filter(q => q.changePercent <= -LIMIT_THRESHOLD);
  const scanSymbols = loadScanResults(market, date);

  const allLimit = [...limitUp, ...limitDown];
  const inScan: string[] = [];
  const diff: DiffEntry[] = [];
  for (const q of allLimit) {
    const code = q.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    if (scanSymbols.has(code)) {
      inScan.push(code);
    } else {
      diff.push({
        symbol: code,
        name: q.name,
        changePercent: q.changePercent,
        reason: classifyReason(market, q, date),
      });
    }
  }

  return {
    market, date,
    limitUpCount: limitUp.length,
    limitDownCount: limitDown.length,
    scanCoveredCount: inScan.length,
    diffCount: diff.length,
    inScanLimit: inScan,
    diffStocks: diff,
  };
}

interface Args { market?: Market; date?: string; json: boolean; write?: string; }
function parseArgs(): Args {
  const a: Args = { json: false };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === '--market') a.market = process.argv[++i] as Market;
    else if (x === '--date') a.date = process.argv[++i];
    else if (x === '--json') a.json = true;
    else if (x === '--write') a.write = process.argv[++i];
  }
  return a;
}

function printSummary(r: AuditResult) {
  console.log(`=== ${r.market} ${r.date} ===`);
  console.log(`  鎖漲停 ${r.limitUpCount} 檔 / 鎖跌停 ${r.limitDownCount} 檔`);
  console.log(`  進 scan: ${r.scanCoveredCount} / 未進 scan: ${r.diffCount}`);
  if (r.diffStocks.length > 0) {
    console.log(`  未進 scan 明細:`);
    const realLeak = r.diffStocks.filter(d => d.reason.includes('真漏掃'));
    const expected = r.diffStocks.filter(d => !d.reason.includes('真漏掃'));
    if (realLeak.length > 0) {
      console.log(`  ★ 真漏掃 ${realLeak.length} 檔（需處理）:`);
      realLeak.forEach(d => console.log(`     ${d.symbol} ${d.name ?? ''} ${d.changePercent.toFixed(2)}% — ${d.reason}`));
    }
    if (expected.length > 0) {
      // 按 reason 分桶
      const buckets: Record<string, DiffEntry[]> = {};
      for (const d of expected) {
        const key = d.reason;
        (buckets[key] ??= []).push(d);
      }
      const sortedBuckets = Object.entries(buckets).sort((a, b) => b[1].length - a[1].length);
      console.log(`  預期排除 ${expected.length} 檔，按原因分組:`);
      for (const [reason, items] of sortedBuckets) {
        console.log(`    [${items.length} 檔] ${reason}`);
        items.slice(0, 5).forEach(d =>
          console.log(`       ${d.symbol} ${d.name ?? ''} ${d.changePercent.toFixed(2)}%`));
        if (items.length > 5) console.log(`       …還有 ${items.length - 5} 檔`);
      }
    }
  }
}

async function main() {
  const args = parseArgs();
  const markets: Market[] = args.market ? [args.market] : ['TW', 'CN'];
  const results = await Promise.all(
    markets.map(m => auditMarket(m, args.date ?? getLastTradingDay(m))),
  );

  if (args.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), markets: results }, null, 2));
  } else {
    results.forEach(printSummary);
  }

  if (args.write) {
    const outPath = path.resolve(args.write);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      markets: results,
    }, null, 2));
    console.log(`已寫入 ${outPath}`);
  }

  const realLeakTotal = results.reduce(
    (sum, r) => sum + r.diffStocks.filter(d => d.reason.includes('真漏掃')).length,
    0,
  );
  if (realLeakTotal > 0) {
    console.error(`★ 偵測 ${realLeakTotal} 檔真漏掃，請 backfill L1 後重跑 scan`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(2); });
