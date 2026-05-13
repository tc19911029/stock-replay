/**
 * Repair L1 OHLC invariant violations
 *
 * 設計動機（2026-05-13）：
 * 全歷史 L1 audit 發現 5773 筆 OHLC 內部矛盾（close > high 或 close < low），
 * 多源 fallback 重抓覆寫。最後手段 clip 保 invariant。
 *
 * Vendor chain：
 *   1. EODHD per-symbol (raw OHLC)
 *   2. Yahoo Chart per-symbol (curl fallback)
 *   3. TWSE MI_INDEX bulk per-date (TW only, cached per-date)
 *   4. 最後手段：clip C 到 [L, H] 範圍內保 invariant
 *
 * 用法：
 *   npx tsx scripts/repair-l1-invariant.ts                       # dry-run
 *   npx tsx scripts/repair-l1-invariant.ts --apply               # 全 apply
 *   npx tsx scripts/repair-l1-invariant.ts --apply --concurrency 8
 *   npx tsx scripts/repair-l1-invariant.ts --apply --min-diff 0.01  # 只修差距 >1%
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { fetchJsonWithCurlFallback } from '../lib/datasource/curlFetch';

type Market = 'TW' | 'CN';
interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number; }
interface Violation {
  market: Market;
  sym: string;
  date: string;
  current: Candle;
  diffPct: number;     // close vs [L, H] 邊界差距
  type: 'close>high' | 'close<low';
}

const DATA_ROOT = path.join(process.cwd(), 'data', 'candles');

function loadCandles(market: Market, fname: string): Candle[] {
  try {
    const raw = JSON.parse(readFileSync(path.join(DATA_ROOT, market, fname), 'utf8'));
    return Array.isArray(raw) ? raw : (raw.candles ?? []);
  } catch { return []; }
}

function findViolations(minDiff = 0): Violation[] {
  const out: Violation[] = [];
  for (const m of ['TW', 'CN'] as Market[]) {
    const dir = path.join(DATA_ROOT, m);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const candles = loadCandles(m, f);
      const sym = f.replace('.json', '');
      for (const c of candles) {
        if (c.close > c.high + 0.001) {
          const diff = (c.close - c.high) / c.high;
          if (diff >= minDiff) out.push({ market: m, sym, date: c.date, current: c, diffPct: diff, type: 'close>high' });
        } else if (c.close < c.low - 0.001) {
          const diff = (c.low - c.close) / c.low;
          if (diff >= minDiff) out.push({ market: m, sym, date: c.date, current: c, diffPct: diff, type: 'close<low' });
        }
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
  const t = new Date(date);
  const from = new Date(t); from.setDate(from.getDate() - 3);
  const to = new Date(t); to.setDate(to.getDate() + 1);
  const url = `https://eodhd.com/api/eod/${ticker}?api_token=${token}&from=${from.toISOString().split('T')[0]}&to=${to.toISOString().split('T')[0]}&fmt=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

// ── Vendor 2: Yahoo curl ────────────────────────────────────────────────────
async function fetchYahoo(sym: string, market: Market, date: string): Promise<Candle | null> {
  const t = new Date(date);
  const p1 = Math.floor(new Date(t.getFullYear(), t.getMonth() - 1, t.getDate()).getTime() / 1000);
  const p2 = Math.floor(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getTime() / 1000);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?period1=${p1}&period2=${p2}&interval=1d`;
  try {
    const { data } = await fetchJsonWithCurlFallback<{ chart: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }> } }> } }>(url, { timeoutMs: 8000 });
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
        open: Number(o.toFixed(4)),
        high: Number((h ?? c).toFixed(4)),
        low: Number((l ?? c).toFixed(4)),
        close: Number(c.toFixed(4)),
        volume: market === 'TW' ? Math.round((v ?? 0) / 1000) : (v ?? 0),
      };
    }
    return null;
  } catch { return null; }
}

// ── Vendor 3: TWSE MI_INDEX (TW only, per-date cache) ───────────────────────
const twseCache = new Map<string, Map<string, Candle>>();
async function fetchTwseBulk(date: string): Promise<Map<string, Candle>> {
  if (twseCache.has(date)) return twseCache.get(date)!;
  const d = date.replace(/-/g, '');
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${d}&type=ALLBUT0999`;
  const map = new Map<string, Candle>();
  try {
    const { data } = await fetchJsonWithCurlFallback<{ stat: string; tables: Array<{ data: string[][] }> }>(url, { timeoutMs: 20_000 });
    if (data.stat === 'OK') {
      const table = data.tables?.[8];
      if (table?.data?.length) {
        const num = (s: string) => { const n = parseFloat((s ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
        for (const row of table.data) {
          const code = row[0]?.trim();
          if (!code || !/^\d{4,}[A-Z]?$/.test(code)) continue;
          const open = num(row[5]), high = num(row[6]), low = num(row[7]), close = num(row[8]);
          const volume = Math.round(num(row[2]) / 1000);
          if (close > 0 && open > 0) map.set(code, { date, open, high, low, close, volume });
        }
      }
    }
  } catch { /* ignore */ }
  twseCache.set(date, map);
  return map;
}

// ── Decision: 用哪個 vendor 還是 clip ────────────────────────────────────────

interface RepairAction {
  source: 'eodhd' | 'yahoo' | 'twse' | 'clip' | 'none';
  newCandle: Candle | null;
  rationale: string;
}

function isSelfConsistent(c: Candle): boolean {
  return c.high >= c.low &&
         c.high >= c.open && c.high >= c.close &&
         c.low <= c.open && c.low <= c.close &&
         c.close > 0 && c.high > 0 && c.low > 0;
}

function clipFallback(current: Candle): Candle {
  // 最後手段：把 high 拉到 ≥ close 且 low 拉到 ≤ close，保 invariant
  const high = Math.max(current.high, current.close, current.open);
  const low = Math.min(current.low, current.close, current.open);
  return { ...current, high, low };
}

/** 判斷 vendor 與 L1 是否同 adjustment 版本（close 差距 < 2% 視為同版本）*/
const SAME_ADJUSTMENT_THRESHOLD = 0.02;
function sameAdjustment(vendorClose: number, l1Close: number): boolean {
  if (vendorClose <= 0 || l1Close <= 0) return false;
  return Math.abs(vendorClose - l1Close) / Math.max(vendorClose, l1Close) < SAME_ADJUSTMENT_THRESHOLD;
}

async function tryRepair(v: Violation, token: string): Promise<RepairAction> {
  // L1 多為「後復權版」，vendor 多為 raw。對每個 vendor：
  //   - self-consistent 且 close 跟 L1 接近（< 2% 差）→ 視為「同 adjustment 版本」→ 可覆寫
  //   - close 差距大 → vendor 是不同版本，覆寫會破 L1 連續性 → 不用

  // 1. EODHD
  const eodhd = await fetchEodhd(v.sym, v.market, v.date, token);
  if (eodhd && isSelfConsistent(eodhd) && sameAdjustment(eodhd.close, v.current.close)) {
    return { source: 'eodhd', newCandle: eodhd, rationale: `EODHD close=${eodhd.close} ≈ L1 close=${v.current.close}` };
  }
  // 2. Yahoo
  const yahoo = await fetchYahoo(v.sym, v.market, v.date);
  if (yahoo && isSelfConsistent(yahoo) && sameAdjustment(yahoo.close, v.current.close)) {
    return { source: 'yahoo', newCandle: yahoo, rationale: `Yahoo close=${yahoo.close} ≈ L1 close=${v.current.close}` };
  }
  // 3. TWSE (TW only)
  if (v.market === 'TW') {
    const code = v.sym.replace(/\.(TW|TWO)$/i, '');
    const bulk = await fetchTwseBulk(v.date);
    const c = bulk.get(code);
    if (c && isSelfConsistent(c) && sameAdjustment(c.close, v.current.close)) {
      return { source: 'twse', newCandle: c, rationale: `TWSE close=${c.close} ≈ L1 close=${v.current.close}` };
    }
  }
  // 4. Clip — vendor 都拉不到，或都是不同 adjustment 版本；最小改動保 invariant
  const clipped = clipFallback(v.current);
  return { source: 'clip', newCandle: clipped, rationale: 'vendor 失敗或不同 adjustment 版本 → clip H/L 包住 C' };
}

// ── Main ────────────────────────────────────────────────────────────────────

interface Args { apply: boolean; concurrency: number; minDiff: number; limit: number; }
function parseArgs(): Args {
  const a: Args = { apply: false, concurrency: 6, minDiff: 0, limit: Infinity };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === '--apply') a.apply = true;
    else if (x === '--concurrency') a.concurrency = parseInt(process.argv[++i], 10);
    else if (x === '--min-diff') a.minDiff = parseFloat(process.argv[++i]);
    else if (x === '--limit') a.limit = parseInt(process.argv[++i], 10);
  }
  return a;
}

async function main() {
  const { apply, concurrency, minDiff, limit } = parseArgs();
  const token = process.env.EODHD_API_TOKEN;
  if (!token) { console.error('EODHD_API_TOKEN missing'); process.exit(1); }

  console.log(`Repair L1 invariant: ${apply ? '★ APPLY' : 'DRY-RUN'} concurrency=${concurrency} min-diff=${minDiff}`);
  const violations = findViolations(minDiff).slice(0, limit);
  console.log(`違反清單: ${violations.length} 筆`);

  const stats = { eodhd: 0, yahoo: 0, twse: 0, clip: 0, none: 0 };
  const samples: Record<string, string[]> = { eodhd: [], yahoo: [], twse: [], clip: [] };

  let processed = 0, written = 0;
  for (let i = 0; i < violations.length; i += concurrency) {
    const batch = violations.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(v => tryRepair(v, token!)));
    for (let j = 0; j < batch.length; j++) {
      const v = batch[j], r = results[j];
      stats[r.source]++;
      if (samples[r.source] && samples[r.source].length < 5) {
        samples[r.source].push(`${v.market}/${v.sym}@${v.date}: ${v.type} L1(O=${v.current.open} H=${v.current.high} L=${v.current.low} C=${v.current.close}) → ${r.source} (O=${r.newCandle?.open} H=${r.newCandle?.high} L=${r.newCandle?.low} C=${r.newCandle?.close})`);
      }
      if (apply && r.newCandle) {
        await saveLocalCandles(v.sym, v.market, [r.newCandle]);
        written++;
      }
    }
    processed += batch.length;
    if (processed % 100 === 0 || processed >= violations.length) {
      process.stdout.write(`  進度 ${processed}/${violations.length} (eodhd=${stats.eodhd} yahoo=${stats.yahoo} twse=${stats.twse} clip=${stats.clip} 寫=${written})\n`);
    }
  }

  console.log('---');
  console.log('Vendor 分佈:');
  Object.entries(stats).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log('---樣本---');
  for (const [src, arr] of Object.entries(samples)) {
    if (arr.length === 0) continue;
    console.log(`${src} (${arr.length} 樣本):`);
    arr.forEach(s => console.log(`  ${s}`));
  }
  console.log(`寫入 L1: ${written}`);
}

main().catch(err => { console.error(err); process.exit(1); });
