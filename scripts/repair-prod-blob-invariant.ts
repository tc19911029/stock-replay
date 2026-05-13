/**
 * Prod Blob L1 OHLC invariant 修法 — 直接讀寫 Vercel Blob
 *
 * 跟 repair-l1-invariant.ts 同邏輯，但讀寫對象是 prod Vercel Blob
 * （需 .env.local 有 BLOB_READ_WRITE_TOKEN）。
 *
 * 流程：
 *   1. @vercel/blob list 列 candles/{TW|CN}/*.json 全部
 *   2. 對每個 blob：get → 找 invariant 違反 → vendor 多源
 *   3. vendor close 與 L1 close 差 <2% → 同 adjustment 覆寫
 *      差大 → clip H/L 包住 C 保 invariant
 *   4. blobPut 寫回
 *
 * 用法：
 *   npx tsx scripts/repair-prod-blob-invariant.ts                 # dry-run
 *   npx tsx scripts/repair-prod-blob-invariant.ts --apply
 *   npx tsx scripts/repair-prod-blob-invariant.ts --apply --concurrency 6 --limit 100
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { fetchJsonWithCurlFallback } from '../lib/datasource/curlFetch';

type Market = 'TW' | 'CN';
interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number; }
interface Violation { market: Market; sym: string; date: string; current: Candle; type: 'close>high' | 'close<low'; }

interface Args { apply: boolean; concurrency: number; limit: number; market?: Market; }
function parseArgs(): Args {
  const a: Args = { apply: false, concurrency: 4, limit: Infinity };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === '--apply') a.apply = true;
    else if (x === '--concurrency') a.concurrency = parseInt(process.argv[++i], 10);
    else if (x === '--limit') a.limit = parseInt(process.argv[++i], 10);
    else if (x === '--market') a.market = process.argv[++i] as Market;
  }
  return a;
}

interface BlobEntry { pathname: string; size: number; }

async function listBlobs(prefix: string): Promise<BlobEntry[]> {
  const { list } = await import('@vercel/blob');
  const out: BlobEntry[] = [];
  let cursor: string | undefined;
  do {
    const r = await list({ prefix, limit: 1000, cursor });
    for (const b of r.blobs) out.push({ pathname: b.pathname, size: b.size });
    cursor = r.cursor;
  } while (cursor);
  return out;
}

async function readBlob(pathname: string): Promise<{ candles: Candle[]; rawJson: string } | null> {
  const { get } = await import('@vercel/blob');
  try {
    const r = await get(pathname, { access: 'private' });
    if (!r || !r.stream) return null;
    const reader = r.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) chunks.push(value); }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    const parsed = JSON.parse(text);
    const candles = Array.isArray(parsed) ? parsed : (parsed.candles ?? []);
    return { candles, rawJson: text };
  } catch { return null; }
}

async function writeBlob(pathname: string, candles: Candle[], originalParse: unknown): Promise<void> {
  const { blobPutWithRetry } = await import('../lib/storage/blobRetry');
  // 保留原 schema (Array 直接、Object 帶 candles + sealedDate + lastDate)
  let payload: unknown;
  if (Array.isArray(originalParse)) {
    payload = candles;
  } else {
    const obj = originalParse as Record<string, unknown>;
    payload = {
      ...obj,
      candles,
      lastDate: candles[candles.length - 1]?.date,
      updatedAt: new Date().toISOString(),
    };
  }
  await blobPutWithRetry(pathname, JSON.stringify(payload), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
  });
}

// ── Vendor fetch（與 repair-l1-invariant.ts 相同 chain）─────────────────────

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
      open: row.open, high: row.high, low: row.low, close: row.close,
      volume: market === 'TW' ? Math.round(row.volume / 1000) : row.volume,
    };
  } catch { return null; }
}

function isSelfConsistent(c: Candle): boolean {
  return c.high >= c.low && c.high >= c.open && c.high >= c.close &&
         c.low <= c.open && c.low <= c.close &&
         c.close > 0 && c.high > 0 && c.low > 0;
}

function sameAdjustment(vendor: number, l1: number): boolean {
  if (vendor <= 0 || l1 <= 0) return false;
  return Math.abs(vendor - l1) / Math.max(vendor, l1) < 0.02;
}

function clipFallback(c: Candle): Candle {
  return { ...c, high: Math.max(c.high, c.close, c.open), low: Math.min(c.low, c.close, c.open) };
}

async function repairCandle(v: Violation, token: string): Promise<{ source: string; newCandle: Candle }> {
  const eodhd = await fetchEodhd(v.sym, v.market, v.date, token);
  if (eodhd && isSelfConsistent(eodhd) && sameAdjustment(eodhd.close, v.current.close)) {
    return { source: 'eodhd', newCandle: eodhd };
  }
  return { source: 'clip', newCandle: clipFallback(v.current) };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { apply, concurrency, limit, market: marketFilter } = parseArgs();
  const token = process.env.EODHD_API_TOKEN;
  if (!token) { console.error('EODHD_API_TOKEN missing'); process.exit(1); }
  if (!process.env.BLOB_READ_WRITE_TOKEN) { console.error('BLOB_READ_WRITE_TOKEN missing'); process.exit(1); }

  console.log(`Repair Prod Blob L1 invariant: ${apply ? '★ APPLY' : 'DRY-RUN'} concurrency=${concurrency}`);

  // List blobs
  const markets: Market[] = marketFilter ? [marketFilter] : ['TW', 'CN'];
  let allBlobs: { market: Market; pathname: string; sym: string }[] = [];
  for (const m of markets) {
    console.log(`listing candles/${m}/ ...`);
    const blobs = await listBlobs(`candles/${m}/`);
    for (const b of blobs) {
      const sym = b.pathname.replace(`candles/${m}/`, '').replace('.json', '');
      allBlobs.push({ market: m, pathname: b.pathname, sym });
    }
    console.log(`  ${m}: ${blobs.length} blobs`);
  }
  if (limit < allBlobs.length) {
    allBlobs = allBlobs.slice(0, limit);
    console.log(`limit truncated to ${allBlobs.length}`);
  }

  // Scan + collect violations + repair + write
  const stats = { totalBlobs: 0, blobsWithViolations: 0, totalViolations: 0, repaired: 0, written: 0, eodhd: 0, clip: 0, blobRead: 0, blobWrite: 0 };
  let processed = 0;

  for (let i = 0; i < allBlobs.length; i += concurrency) {
    const batch = allBlobs.slice(i, i + concurrency);
    await Promise.all(batch.map(async ({ market, pathname, sym }) => {
      stats.totalBlobs++;
      const blob = await readBlob(pathname);
      if (!blob) return;
      stats.blobRead++;
      const violations: Violation[] = [];
      for (const c of blob.candles) {
        if (c.close > c.high + 0.001) violations.push({ market, sym, date: c.date, current: c, type: 'close>high' });
        else if (c.close < c.low - 0.001) violations.push({ market, sym, date: c.date, current: c, type: 'close<low' });
      }
      if (violations.length === 0) return;
      stats.blobsWithViolations++;
      stats.totalViolations += violations.length;

      // 修每筆
      const byDate = new Map<string, Candle>();
      for (const c of blob.candles) byDate.set(c.date, c);
      let modified = false;
      for (const v of violations) {
        const { source, newCandle } = await repairCandle(v, token!);
        if (source === 'eodhd') stats.eodhd++; else stats.clip++;
        // 只覆 OHLC，volume 保留（vendor volume 可能單位不同）
        const merged: Candle = source === 'eodhd' ? newCandle : { ...v.current, high: newCandle.high, low: newCandle.low };
        byDate.set(v.date, merged);
        modified = true;
        stats.repaired++;
      }
      if (modified && apply) {
        const newCandles = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
        // 解析原 raw JSON 看 schema
        const originalParse = JSON.parse(blob.rawJson);
        await writeBlob(pathname, newCandles, originalParse);
        stats.blobWrite++;
        stats.written++;
      }
    }));
    processed += batch.length;
    if (processed % 50 === 0 || processed >= allBlobs.length) {
      process.stdout.write(`  ${processed}/${allBlobs.length} blobs scanned, violations=${stats.totalViolations}, repaired=${stats.repaired}, written=${stats.written}\n`);
    }
  }

  console.log('---');
  console.log('Stats:');
  console.log(`  blobs scanned: ${stats.totalBlobs}, with violations: ${stats.blobsWithViolations}`);
  console.log(`  total violations: ${stats.totalViolations}, repaired: ${stats.repaired} (eodhd=${stats.eodhd}, clip=${stats.clip})`);
  console.log(`  blob writes: ${stats.blobWrite}`);
}

main().catch(err => { console.error(err); process.exit(1); });
