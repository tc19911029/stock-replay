/**
 * Repair sandwich vol=0 ghost candles in L1
 *
 * 流程：
 *   1. 掃 L1 找出 sandwich vol=0 (前後 vol>0 但自己 0)
 *   2. 對每筆 (symbol, date) 走 vendor chain 重抓 OHLCV：
 *      EODHD → Yahoo (curl + concurrency=1) → TWSE MI_INDEX (TW only)
 *   3. 比對舊／新 OHLCV，分類：
 *      - vol-only-missing: OHLC 一致但 vol=0 → 只補 volume
 *      - ohlc-mismatch: OHLC 不一致 → 完整覆寫 (log diff)
 *      - real-suspension: 所有 vendor 都回 vol=0 → 跳過（真停牌）
 *      - no-vendor-data: 沒任何 vendor 回 → 跳過、留紀錄
 *   4. dry-run 預設只輸出 diff 報告；--apply 才寫入 L1
 *
 * 用法：
 *   npx tsx scripts/repair-vol0-sandwich.ts                     # 全部 dry-run
 *   npx tsx scripts/repair-vol0-sandwich.ts --top-dates 6       # 只跑 top 6 集中日
 *   npx tsx scripts/repair-vol0-sandwich.ts --top-dates 6 --apply
 *   npx tsx scripts/repair-vol0-sandwich.ts --date 2021-08-17 --market TW
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { fetchJsonWithCurlFallback } from '../lib/datasource/curlFetch';

type Market = 'TW' | 'CN';
interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number; }
interface BadEntry { sym: string; market: Market; date: string; current: Candle; }

const DATA_ROOT = path.join(process.cwd(), 'data', 'candles');

function loadCandles(market: Market, fname: string): Candle[] {
  const f = path.join(DATA_ROOT, market, fname);
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.candles ?? []);
  } catch { return []; }
}

function findSandwichBad(market: Market, dateFilter?: Set<string>): BadEntry[] {
  const dir = path.join(DATA_ROOT, market);
  if (!existsSync(dir)) return [];
  const out: BadEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const candles = loadCandles(market, f);
    const sym = f.replace('.json', '');
    for (let i = 1; i < candles.length - 1; i++) {
      const c = candles[i];
      if (c.volume !== 0 || c.close <= 0) continue;
      if (dateFilter && !dateFilter.has(c.date)) continue;
      const prev = candles[i - 1], next = candles[i + 1];
      if (prev.volume > 0 && next.volume > 0) {
        out.push({ sym, market, date: c.date, current: c });
      }
    }
  }
  return out;
}

// ── Vendor 1: EODHD ─────────────────────────────────────────────────────────
function toEodhdTicker(sym: string, market: Market): string {
  if (market === 'TW') return sym;
  if (sym.endsWith('.SS')) return sym.replace('.SS', '.SHG');
  if (sym.endsWith('.SZ')) return sym.replace('.SZ', '.SHE');
  return sym;
}

async function fetchEodhd(sym: string, market: Market, date: string, token: string): Promise<Candle | null> {
  const ticker = toEodhdTicker(sym, market);
  const target = new Date(date);
  const from = new Date(target); from.setDate(from.getDate() - 3);
  const to = new Date(target); to.setDate(to.getDate() + 1);
  const url = `https://eodhd.com/api/eod/${ticker}?api_token=${token}&from=${from.toISOString().split('T')[0]}&to=${to.toISOString().split('T')[0]}&fmt=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const rows = await res.json() as Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
    if (!Array.isArray(rows)) return null;
    const row = rows.find(r => r.date === date);
    if (!row) return null;
    return {
      date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: market === 'TW' ? Math.round(row.volume / 1000) : row.volume,
    };
  } catch { return null; }
}

// ── Vendor 2: Yahoo (curl, sequential) ───────────────────────────────────────
async function fetchYahoo(sym: string, market: Market, date: string): Promise<Candle | null> {
  // Yahoo: TW 用 1240.TWO, CN 用 600519.SS / 000001.SZ 直接
  const target = new Date(date);
  const p1 = Math.floor(new Date(target.getFullYear(), target.getMonth() - 1, target.getDate()).getTime() / 1000);
  const p2 = Math.floor(new Date(target.getFullYear(), target.getMonth(), target.getDate() + 1).getTime() / 1000);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?period1=${p1}&period2=${p2}&interval=1d`;
  try {
    const { data } = await fetchJsonWithCurlFallback<{ chart: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }> } }> } }>(url, { timeoutMs: 10_000 });
    const r = data.chart.result?.[0];
    if (!r) return null;
    const ts = r.timestamp ?? [];
    const q = r.indicators?.quote?.[0];
    if (!q) return null;
    for (let i = 0; i < ts.length; i++) {
      const d = new Date(ts[i] * 1000).toISOString().split('T')[0];
      if (d !== date) continue;
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
      if (o == null || c == null) return null;
      return {
        date,
        open: Number(o.toFixed(2)),
        high: Number((h ?? c).toFixed(2)),
        low: Number((l ?? c).toFixed(2)),
        close: Number(c.toFixed(2)),
        volume: market === 'TW' ? Math.round((v ?? 0) / 1000) : (v ?? 0),
      };
    }
    return null;
  } catch { return null; }
}

// ── Vendor 3: TWSE MI_INDEX (TW only) ────────────────────────────────────────
const twseCache = new Map<string, Map<string, Candle>>();
async function fetchTwseMiIndex(date: string): Promise<Map<string, Candle>> {
  if (twseCache.has(date)) return twseCache.get(date)!;
  const d = date.replace(/-/g, '');
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${d}&type=ALLBUT0999`;
  try {
    const { data } = await fetchJsonWithCurlFallback<{ stat: string; tables: Array<{ fields: string[]; data: string[][] }> }>(url, { timeoutMs: 30_000 });
    const map = new Map<string, Candle>();
    if (data.stat !== 'OK') { twseCache.set(date, map); return map; }
    const table = data.tables?.[8];
    if (!table?.data?.length) { twseCache.set(date, map); return map; }
    const num = (s: string) => { const n = parseFloat((s ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
    for (const row of table.data) {
      const code = row[0]?.trim();
      if (!code || !/^\d{4,}[A-Z]?$/.test(code)) continue;
      const open = num(row[5]), high = num(row[6]), low = num(row[7]), close = num(row[8]);
      const volume = Math.round(num(row[2]) / 1000);
      if (close > 0 && open > 0) map.set(code, { date, open, high, low, close, volume });
    }
    twseCache.set(date, map);
    return map;
  } catch { const m = new Map<string, Candle>(); twseCache.set(date, m); return m; }
}

// ── 分類 + 修法 ─────────────────────────────────────────────────────────────
type Verdict = 'vol-only-missing' | 'ohlc-mismatch' | 'real-suspension' | 'no-vendor-data';

function classifyDiff(current: Candle, fresh: Candle | null): Verdict {
  if (!fresh) return 'no-vendor-data';
  if (fresh.volume === 0) return 'real-suspension';
  // OHLC 容忍 1% 差距（含 stock split / 除權息調整 / vendor 微差）
  const tol = (a: number, b: number) => a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) < 0.01;
  if (tol(current.open, fresh.open) && tol(current.high, fresh.high) && tol(current.low, fresh.low) && tol(current.close, fresh.close)) {
    return 'vol-only-missing';
  }
  return 'ohlc-mismatch';
}

interface Args { dates?: string[]; market?: Market; topDates?: number; all: boolean; apply: boolean; applyMismatch: boolean; limit: number; }
function parseArgs(): Args {
  const a: Args = { apply: false, applyMismatch: false, all: false, limit: Infinity };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === '--date') (a.dates ??= []).push(process.argv[++i]);
    else if (x === '--market') a.market = process.argv[++i] as Market;
    else if (x === '--top-dates') a.topDates = parseInt(process.argv[++i], 10);
    else if (x === '--all') a.all = true;
    else if (x === '--apply') a.apply = true;
    else if (x === '--apply-mismatch') { a.apply = true; a.applyMismatch = true; }
    else if (x === '--limit') a.limit = parseInt(process.argv[++i], 10);
  }
  return a;
}

async function pickTopDates(n: number): Promise<{ market: Market; date: string; count: number }[]> {
  const counts: Record<string, number> = {};
  for (const market of ['TW', 'CN'] as Market[]) {
    const bads = findSandwichBad(market);
    for (const b of bads) counts[`${market}|${b.date}`] = (counts[`${market}|${b.date}`] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, count]) => { const [market, date] = k.split('|'); return { market: market as Market, date, count }; });
}

async function main() {
  const args = parseArgs();
  const token = process.env.EODHD_API_TOKEN;
  if (!token) { console.error('EODHD_API_TOKEN missing'); process.exit(1); }

  // 決定要處理哪些日期
  let scope: { market: Market; date: string }[] = [];
  const allMode = args.all;
  if (allMode) {
    console.log(`處理範圍：全部 sandwich vol=0（不限日期）${args.apply ? '★ APPLY' : 'DRY-RUN'}`);
  } else if (args.dates && args.dates.length > 0) {
    const markets: Market[] = args.market ? [args.market] : ['TW', 'CN'];
    for (const m of markets) for (const d of args.dates) scope.push({ market: m, date: d });
  } else if (args.topDates) {
    scope = (await pickTopDates(args.topDates)).map(t => ({ market: t.market, date: t.date }));
  } else {
    scope = (await pickTopDates(20)).map(t => ({ market: t.market, date: t.date }));
  }
  if (!allMode) console.log(`處理範圍：${scope.length} 個 (market, date)，${args.apply ? '★ APPLY' : 'DRY-RUN'}`);

  const dateBuckets = new Map<string, Set<string>>(); // market → date set
  for (const s of scope) {
    if (!dateBuckets.has(s.market)) dateBuckets.set(s.market, new Set());
    dateBuckets.get(s.market)!.add(s.date);
  }

  const allBad: BadEntry[] = [];
  if (allMode) {
    for (const m of (args.market ? [args.market] : ['TW', 'CN'] as Market[])) {
      allBad.push(...findSandwichBad(m));
    }
  } else {
    for (const [market, dates] of dateBuckets) {
      const m = market as Market;
      const bad = findSandwichBad(m, dates);
      allBad.push(...bad);
    }
  }
  console.log(`掃出 sandwich vol=0：${allBad.length} 筆`);
  if (args.limit < allBad.length) {
    allBad.length = args.limit;
    console.log(`  truncate 到前 ${args.limit} 筆`);
  }

  // verdict 分類統計
  const stats = { 'vol-only-missing': 0, 'ohlc-mismatch': 0, 'real-suspension': 0, 'no-vendor-data': 0 };
  const samples = { 'vol-only-missing': [] as string[], 'ohlc-mismatch': [] as string[], 'real-suspension': [] as string[], 'no-vendor-data': [] as string[] };

  // Streaming：每 batch fetch 完立刻分類 + 寫入；progress 即時 flush stdout
  let processed = 0, written = 0;
  const repairs: Array<{ b: BadEntry; verdict: Verdict; fresh: Candle | null; source: string }> = [];
  const concurrency = 8;

  for (let i = 0; i < allBad.length; i += concurrency) {
    const batch = allBad.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(async b => {
      let fresh = await fetchEodhd(b.sym, b.market, b.date, token!);
      let source = fresh ? 'eodhd' : 'none';
      if (!fresh && b.market === 'TW') {
        const twseMap = await fetchTwseMiIndex(b.date);
        const code = b.sym.replace(/\.(TW|TWO)$/i, '');
        const c = twseMap.get(code);
        if (c) { fresh = c; source = 'twse-mi'; }
      }
      return { b, fresh, source };
    }));

    for (const { b, fresh, source } of batchResults) {
      const verdict = classifyDiff(b.current, fresh);
      stats[verdict]++;
      if (samples[verdict].length < 8) {
        const summary = `${b.market} ${b.sym} ${b.date}`;
        if (verdict === 'ohlc-mismatch' && fresh) {
          samples[verdict].push(`${summary}: L1 O=${b.current.open}/H=${b.current.high}/L=${b.current.low}/C=${b.current.close} vs ${source} O=${fresh.open}/H=${fresh.high}/L=${fresh.low}/C=${fresh.close} V=${fresh.volume}`);
        } else if (verdict === 'vol-only-missing' && fresh) {
          samples[verdict].push(`${summary}: vol 0 → ${fresh.volume} (${source}, OHLC 一致)`);
        } else if (verdict === 'real-suspension') {
          samples[verdict].push(`${summary}: ${source} 也 vol=0`);
        } else {
          samples[verdict].push(`${summary}: ${source}/vendor 沒資料`);
        }
      }
      repairs.push({ b, verdict, fresh, source });

      // Streaming apply
      if (args.apply && fresh && fresh.volume > 0 &&
          (verdict === 'vol-only-missing' || verdict === 'ohlc-mismatch')) {
        const merged: Candle = { ...b.current, volume: fresh.volume };
        await saveLocalCandles(b.sym, b.market, [merged]);
        written++;
      }
    }
    processed += batch.length;
    if (processed % 200 === 0 || processed >= allBad.length) {
      process.stdout.write(`  進度 ${processed}/${allBad.length} (寫入 ${written})\n`);
    }
  }

  console.log('---');
  console.log('分類統計:');
  for (const [v, n] of Object.entries(stats)) {
    console.log(`  ${v}: ${n}`);
    samples[v as Verdict].slice(0, 5).forEach(s => console.log(`    ${s}`));
  }

  if (!args.apply) {
    console.log('---');
    console.log(`DRY-RUN — 加 --apply 才寫入 L1`);
  } else {
    console.log('---');
    console.log(`★ 只補 volume，總共寫入 ${written} 筆（OHLC 保留 L1 後復權版）`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
