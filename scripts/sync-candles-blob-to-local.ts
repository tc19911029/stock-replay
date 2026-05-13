#!/usr/bin/env npx tsx
/**
 * sync-candles-blob-to-local.ts
 *
 * 把 Vercel Blob 上的 candles/{TW|CN}/*.json 同步到 local data/candles/{TW|CN}/。
 *
 * 目的：本地 L1 candle 跟 prod 不一致時（盤中快照沒被收盤結算覆蓋等），
 *      用 prod 數據覆寫本地，確保歷史 backfill / probe 都用同一份 ground truth。
 *
 * 0510 教訓：4749.TWO 5/6 close 本地=1005 / prod=1010；5/7 close 本地=999 / prod=987。
 *           detectTrend 因此分歧 → 池子組成洗掉。
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/sync-candles-blob-to-local.ts                  # dry-run TW+CN, 報告 diff
 *   npx tsx scripts/sync-candles-blob-to-local.ts --apply          # 實際覆寫
 *   ... --markets TW                                                # 只做 TW
 *   ... --recent 90                                                 # 只比對最近 90 天的 candle 差異（預設 60）
 */

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import * as path from 'path';

const APPLY = process.argv.includes('--apply');
function arg(name: string, fallback: string): string {
  const i = process.argv.findIndex((a) => a === `--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}
const RECENT_DAYS = Number(arg('recent', '60'));
const MARKETS = arg('markets', 'TW,CN').split(',').map((s) => s.trim().toUpperCase()).filter((m) => m === 'TW' || m === 'CN') as ('TW' | 'CN')[];
const DATA_DIR = path.join(process.cwd(), 'data', 'candles');

interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number }
interface CandleFile { symbol: string; lastDate?: string; candles: Candle[] }
interface DiffSummary {
  symbol: string;
  diffDates: Array<{ date: string; field: string; local: number; prod: number }>;
  localOnly: string[];
  prodOnly: string[];
}

async function blobList(prefix: string, token: string): Promise<Array<{ pathname: string; url: string; size: number }>> {
  const { list } = await import('@vercel/blob');
  const out: Array<{ pathname: string; url: string; size: number }> = [];
  let cursor: string | undefined;
  do {
    const res = await list({ prefix, limit: 1000, cursor, token });
    out.push(...res.blobs.map((b) => ({ pathname: b.pathname, url: b.url, size: b.size })));
    cursor = res.hasMore ? res.cursor : undefined;
  } while (cursor);
  return out;
}

async function blobReadJsonOnce(pathname: string, token: string): Promise<CandleFile | null> {
  const { get } = await import('@vercel/blob');
  const r = await get(pathname, { access: 'private', token });
  if (!r || !r.stream) return null;
  const reader = r.stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) chunks.push(value); }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try { return JSON.parse(text) as CandleFile; } catch { return null; }
}

async function blobReadJson(pathname: string, token: string, attempts = 4): Promise<CandleFile | null> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const v = await blobReadJsonOnce(pathname, token);
      if (v !== null) return v;
    } catch (err) { lastErr = err; }
    // exponential backoff: 250ms, 500ms, 1s, 2s
    await new Promise((r) => setTimeout(r, 250 * Math.pow(2, i)));
  }
  if (lastErr) console.error(`  [retry-exhausted] ${pathname}:`, (lastErr as Error)?.message ?? lastErr);
  return null;
}

function computeDiff(local: CandleFile | null, prod: CandleFile, recentCutoff: string): DiffSummary | null {
  const symbol = prod.symbol;
  if (!local) return { symbol, diffDates: [], localOnly: [], prodOnly: prod.candles.filter((c) => c.date >= recentCutoff).map((c) => c.date) };
  const localMap = new Map(local.candles.map((c) => [c.date, c]));
  const prodMap = new Map(prod.candles.map((c) => [c.date, c]));
  const allDates = [...new Set([...localMap.keys(), ...prodMap.keys()])].filter((d) => d >= recentCutoff).sort();
  const diffDates: DiffSummary['diffDates'] = [];
  const localOnly: string[] = [];
  const prodOnly: string[] = [];
  for (const d of allDates) {
    const l = localMap.get(d);
    const p = prodMap.get(d);
    if (!p) { localOnly.push(d); continue; }
    if (!l) { prodOnly.push(d); continue; }
    for (const f of ['open', 'high', 'low', 'close', 'volume'] as const) {
      if (l[f] !== p[f]) diffDates.push({ date: d, field: f, local: l[f], prod: p[f] });
    }
  }
  if (diffDates.length === 0 && localOnly.length === 0 && prodOnly.length === 0) return null;
  return { symbol, diffDates, localOnly, prodOnly };
}

async function syncMarket(market: 'TW' | 'CN', token: string): Promise<{ checked: number; diff: number; written: number; sampleDiffs: DiffSummary[] }> {
  const localDir = path.join(DATA_DIR, market);
  if (!existsSync(localDir)) await fs.mkdir(localDir, { recursive: true });
  const prefix = `candles/${market}/`;
  console.log(`\n[${market}] 列出 prod blob ${prefix} ...`);
  const blobs = await blobList(prefix, token);
  console.log(`[${market}] prod 有 ${blobs.length} 檔`);

  const today = new Date();
  const cutoffDate = new Date(today.getTime() - RECENT_DAYS * 86400_000).toISOString().slice(0, 10);

  let checked = 0, diffCount = 0, written = 0;
  const sampleDiffs: DiffSummary[] = [];

  for (const b of blobs) {
    checked++;
    const fname = b.pathname.replace(prefix, '');
    const localPath = path.join(localDir, fname);
    let localData: CandleFile | null = null;
    if (existsSync(localPath)) {
      try { localData = JSON.parse(await fs.readFile(localPath, 'utf-8')) as CandleFile; } catch { /* corrupted */ }
    }
    const prodData = await blobReadJson(b.pathname, token);
    if (!prodData) {
      console.log(`  [${checked}/${blobs.length}] ${fname}: prod read failed, skip`);
      continue;
    }
    const diff = computeDiff(localData, prodData, cutoffDate);
    if (diff) {
      diffCount++;
      if (sampleDiffs.length < 20) sampleDiffs.push(diff);
      if (APPLY) {
        await fs.writeFile(localPath, JSON.stringify(prodData));
        written++;
      }
    }
    if (checked % 200 === 0) console.log(`  [${checked}/${blobs.length}] diff=${diffCount} written=${written}`);
  }

  return { checked, diff: diffCount, written, sampleDiffs };
}

async function main() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) { console.error('需要 BLOB_READ_WRITE_TOKEN（先 source .env.local）'); process.exit(1); }
  console.log(`=== Candles Blob → Local · ${APPLY ? 'APPLY' : 'DRY-RUN'} ===`);
  console.log(`比對最近 ${RECENT_DAYS} 天的 candle 差異 / 市場：${MARKETS.join(',')}`);

  const results: Record<string, Awaited<ReturnType<typeof syncMarket>>> = {};
  for (const m of MARKETS) {
    results[m] = await syncMarket(m, token);
  }

  console.log('\n=== 結果摘要 ===');
  for (const [m, r] of Object.entries(results)) {
    console.log(`[${m}] checked=${r.checked} 有差異=${r.diff} 已覆寫=${r.written}`);
  }
  console.log('\n=== 差異樣本（前 20 支）===');
  for (const [m, r] of Object.entries(results)) {
    for (const s of r.sampleDiffs.slice(0, 5)) {
      console.log(`\n[${m}] ${s.symbol}`);
      if (s.diffDates.length) console.log(`  diff fields:`, s.diffDates.slice(0, 6).map((d) => `${d.date}:${d.field}=${d.local}→${d.prod}`).join(' | '));
      if (s.localOnly.length) console.log(`  local only:`, s.localOnly.slice(0, 5).join(','));
      if (s.prodOnly.length) console.log(`  prod only:`, s.prodOnly.slice(0, 5).join(','));
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
