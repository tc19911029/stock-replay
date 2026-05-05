/**
 * v2: 用本地 candle 直接重算 changePercent 當 ground truth，
 *     找出 Blob 上所有 scan 檔的 changePercent stale。
 *     這個版本不依賴本地 scan JSON 存在。
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { list } from '@vercel/blob';

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN!;
if (!TOKEN) { console.error('需要 BLOB_READ_WRITE_TOKEN'); process.exit(1); }

interface Candle { date: string; close: number; }
const candleCache = new Map<string, Candle[]>();

async function loadCandles(market: string, symbol: string): Promise<Candle[] | null> {
  const key = `${market}/${symbol}`;
  if (candleCache.has(key)) return candleCache.get(key)!;
  const fp = path.join('data', 'candles', market, `${symbol}.json`);
  if (!existsSync(fp)) { candleCache.set(key, []); return null; }
  const raw = await fs.readFile(fp, 'utf8');
  const j = JSON.parse(raw);
  const cs = (j.candles ?? []) as Candle[];
  candleCache.set(key, cs);
  return cs;
}

function expectedChange(candles: Candle[], date: string): number | null {
  const idx = candles.findIndex(c => c.date.slice(0, 10) === date);
  if (idx <= 0) return null;
  const prev = candles[idx - 1];
  if (!prev || prev.close <= 0) return null;
  return (candles[idx].close - prev.close) / prev.close * 100;
}

interface ScanResult { symbol: string; changePercent: number; name?: string; }
interface ScanFile { date: string; results: ScanResult[]; }

interface StaleEntry {
  blobPath: string;
  market: string;
  date: string;
  totalResults: number;
  mismatches: Array<{ symbol: string; blob: number; expected: number }>;
}

async function listAllScans() {
  const out: Array<{ pathname: string; url: string }> = [];
  let cursor: string | undefined;
  do {
    const r = await list({ token: TOKEN, prefix: 'scans/', cursor, limit: 1000 });
    for (const b of r.blobs) {
      // 排除 intraday 變體（盤中價跟收盤後 prev 算法不同）
      if (b.pathname.includes('/intraday/')) continue;
      out.push({ pathname: b.pathname, url: b.url });
    }
    cursor = r.cursor;
  } while (cursor);
  return out;
}

function parseBlobPath(p: string) {
  const m = p.match(/^scans\/([A-Z]+)\/(long|short)\/([A-Za-z]+)\/(\d{4}-\d{2}-\d{2})\.json$/);
  return m ? { market: m[1], direction: m[2], mtfMode: m[3], date: m[4] } : null;
}

async function main() {
  console.log('📋 列出 Blob scans/...');
  const all = await listAllScans();
  console.log(`  共 ${all.length} 個 scan 檔（已排除 intraday）`);

  const stale: StaleEntry[] = [];
  let checked = 0;
  for (const b of all) {
    const parsed = parseBlobPath(b.pathname);
    if (!parsed) continue;
    if (parsed.market !== 'TW' && parsed.market !== 'CN') continue;

    let scanJson: ScanFile;
    try {
      scanJson = await fetch(b.url, { headers: { Authorization: `Bearer ${TOKEN}` } })
        .then(r => r.json()) as ScanFile;
    } catch { continue; }

    const mismatches: Array<{ symbol: string; blob: number; expected: number }> = [];
    for (const r of scanJson.results ?? []) {
      const candles = await loadCandles(parsed.market, r.symbol);
      if (!candles || candles.length === 0) continue;
      const exp = expectedChange(candles, parsed.date);
      if (exp == null) continue;
      if (Math.abs(r.changePercent - exp) > 0.5) {
        mismatches.push({ symbol: r.symbol, blob: r.changePercent, expected: exp });
      }
    }

    checked++;
    if (mismatches.length > 0) {
      stale.push({
        blobPath: b.pathname,
        market: parsed.market,
        date: parsed.date,
        totalResults: scanJson.results?.length ?? 0,
        mismatches,
      });
    }
    if (checked % 50 === 0) process.stdout.write(`\r  進度 ${checked}/${all.length}  stale=${stale.length}      `);
  }
  console.log();
  console.log(`\n✅ 完成 ${checked} 個檔, ${stale.length} 個 stale`);
  console.log();

  // Group by date for readability
  const byDate = new Map<string, StaleEntry[]>();
  for (const s of stale) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date)!.push(s);
  }
  const dates = [...byDate.keys()].sort();
  for (const d of dates) {
    const entries = byDate.get(d)!;
    const totalMis = entries.reduce((sum, e) => sum + e.mismatches.length, 0);
    console.log(`📅 ${d}  ${entries.length} 檔 / ${totalMis} 筆 stale`);
    for (const e of entries) {
      console.log(`   ${e.blobPath}  ${e.mismatches.length}/${e.totalResults}`);
      for (const m of e.mismatches.slice(0, 3)) {
        console.log(`     ${m.symbol.padEnd(12)} blob=${m.blob.toFixed(2)}% expected=${m.expected.toFixed(2)}%`);
      }
      if (e.mismatches.length > 3) console.log(`     … 還有 ${e.mismatches.length - 3} 筆`);
    }
  }

  await fs.writeFile('data/_blob-scan-stale-report-v2.json', JSON.stringify(stale, null, 2));
  console.log('\n📄 報告: data/_blob-scan-stale-report-v2.json');
}

main().catch(e => { console.error(e); process.exit(1); });
