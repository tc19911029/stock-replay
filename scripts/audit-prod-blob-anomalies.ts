/**
 * Audit prod Vercel Blob L1 — 分類 sandwich vol=0 / OHLC invariant
 *
 * 直讀 Vercel Blob、跑 known-anomalies registry 規則匹配。
 * 用戶要求「停牌的或不是我們的問題要有記錄」— 對 prod 也確認 unknown=0。
 *
 * 用法：
 *   npx tsx scripts/audit-prod-blob-anomalies.ts
 *   npx tsx scripts/audit-prod-blob-anomalies.ts --market TW --concurrency 8
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { matchAnomaly } from '../lib/datasource/knownAnomalies';

type Market = 'TW' | 'CN';
interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number; }

interface Args { concurrency: number; market?: Market; limit: number; }
function parseArgs(): Args {
  const a: Args = { concurrency: 6, limit: Infinity };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === '--market') a.market = process.argv[++i] as Market;
    else if (x === '--concurrency') a.concurrency = parseInt(process.argv[++i], 10);
    else if (x === '--limit') a.limit = parseInt(process.argv[++i], 10);
  }
  return a;
}

async function listBlobs(prefix: string): Promise<string[]> {
  const { list } = await import('@vercel/blob');
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const r = await list({ prefix, limit: 1000, cursor });
    for (const b of r.blobs) out.push(b.pathname);
    cursor = r.cursor;
  } while (cursor);
  return out;
}

async function readBlob(pathname: string): Promise<Candle[] | null> {
  const { get } = await import('@vercel/blob');
  try {
    const r = await get(pathname, { access: 'private' });
    if (!r || !r.stream) return null;
    const reader = r.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) chunks.push(value); }
    const j = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    return Array.isArray(j) ? j : (j.candles ?? []);
  } catch { return null; }
}

async function main() {
  const args = parseArgs();
  if (!process.env.BLOB_READ_WRITE_TOKEN) { console.error('BLOB_READ_WRITE_TOKEN missing'); process.exit(1); }

  console.log(`Audit Prod Blob L1 anomalies: concurrency=${args.concurrency}`);

  const markets: Market[] = args.market ? [args.market] : ['TW', 'CN'];
  let blobs: { market: Market; pathname: string; sym: string }[] = [];
  for (const m of markets) {
    console.log(`listing candles/${m}/ ...`);
    const list = await listBlobs(`candles/${m}/`);
    for (const p of list) {
      const sym = p.replace(`candles/${m}/`, '').replace('.json', '');
      blobs.push({ market: m, pathname: p, sym });
    }
    console.log(`  ${m}: ${list.length} blobs`);
  }
  if (args.limit < blobs.length) {
    blobs = blobs.slice(0, args.limit);
    console.log(`limit ${blobs.length}`);
  }

  const stats = {
    sandwich_vol_zero_total: 0,
    sandwich_vol_zero_known: 0,
    sandwich_vol_zero_unknown: 0,
    invariant_total: 0,
    invariant_known: 0,
    invariant_unknown: 0,
  };
  const unknownSamples: string[] = [];

  let processed = 0;
  for (let i = 0; i < blobs.length; i += args.concurrency) {
    const batch = blobs.slice(i, i + args.concurrency);
    await Promise.all(batch.map(async ({ market, pathname, sym }) => {
      const cs = await readBlob(pathname);
      if (!cs) return;
      // sandwich vol=0
      for (let j = 1; j < cs.length - 1; j++) {
        const c = cs[j];
        if (c.volume !== 0 || c.close <= 0) continue;
        const prev = cs[j - 1], next = cs[j + 1];
        if (!(prev.volume > 0 && next.volume > 0)) continue;
        stats.sandwich_vol_zero_total++;
        const m = matchAnomaly('sandwich-vol-zero', {
          symbol: sym, date: c.date, current: c,
          prev: { close: prev.close }, next: { open: next.open, close: next.close },
        });
        if (m) stats.sandwich_vol_zero_known++;
        else {
          stats.sandwich_vol_zero_unknown++;
          if (unknownSamples.length < 10) unknownSamples.push(`${market}/${sym}@${c.date} O=${c.open} H=${c.high} L=${c.low} C=${c.close}`);
        }
      }
      // OHLC invariant
      for (const c of cs) {
        if (c.close > c.high + 0.001 || c.close < c.low - 0.001) {
          stats.invariant_total++;
          const m = matchAnomaly('l1-ohlc-invariant-violation', { symbol: sym, date: c.date, current: c });
          if (m) stats.invariant_known++;
          else {
            stats.invariant_unknown++;
            if (unknownSamples.length < 10) unknownSamples.push(`${market}/${sym}@${c.date} INV O=${c.open} H=${c.high} L=${c.low} C=${c.close}`);
          }
        }
      }
    }));
    processed += batch.length;
    if (processed % 200 === 0 || processed >= blobs.length) {
      process.stdout.write(`  ${processed}/${blobs.length} blobs (vol0=${stats.sandwich_vol_zero_total}, inv=${stats.invariant_total}, unknown=${stats.sandwich_vol_zero_unknown + stats.invariant_unknown})\n`);
    }
  }

  console.log('---');
  console.log('Sandwich vol=0:', stats.sandwich_vol_zero_total, 'known:', stats.sandwich_vol_zero_known, 'unknown:', stats.sandwich_vol_zero_unknown);
  console.log('OHLC invariant:', stats.invariant_total, 'known:', stats.invariant_known, 'unknown:', stats.invariant_unknown);
  if (unknownSamples.length > 0) {
    console.log('---unknown samples---');
    unknownSamples.forEach(s => console.log(' ', s));
  }
  const totalUnknown = stats.sandwich_vol_zero_unknown + stats.invariant_unknown;
  if (totalUnknown > 0) {
    console.error(`★ ${totalUnknown} unknown anomaly — please register or repair`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
