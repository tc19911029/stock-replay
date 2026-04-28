/**
 * 第二輪：Yahoo fallback 補抓 FinMind 撞額度的 384 支
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { writeCandleFile } from '../lib/datasource/CandleStorageAdapter';

const TARGET = '2026-04-28';
const CONCURRENCY = 6;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function fetchYahoo(symbol: string): Promise<{ date: string; open: number; high: number; low: number; close: number; volume: number }[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=10d`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as {
    chart?: { result?: { timestamp?: number[]; indicators: { quote: { open: (number|null)[]; high: (number|null)[]; low: (number|null)[]; close: (number|null)[]; volume: (number|null)[] }[] } }[] }
  };
  const r = json.chart?.result?.[0];
  if (!r?.timestamp) return [];
  const q = r.indicators.quote[0];
  const out: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const close = q.close[i];
    if (close == null || close <= 0) continue;
    const d = new Date(r.timestamp[i] * 1000);
    const date = d.toISOString().slice(0, 10);
    out.push({
      date,
      open: q.open[i] ?? close,
      high: q.high[i] ?? close,
      low: q.low[i] ?? close,
      close,
      volume: Math.round((q.volume[i] ?? 0) / 1000), // 股 → 張
    });
  }
  return out;
}

async function findMissing(): Promise<{ symbol: string }[]> {
  const dir = path.join('data', 'candles', 'TW');
  const files = await fs.readdir(dir);
  const out: { symbol: string }[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as { candles: { date: string }[] };
      if (!j.candles?.length) continue;
      if (j.candles[j.candles.length - 1].date < TARGET) {
        out.push({ symbol: f.replace('.json', '') });
      }
    } catch { /* skip */ }
  }
  return out;
}

async function main() {
  const missing = await findMissing();
  console.log(`🔍 ${missing.length} 支仍需補抓\n`);

  let ok = 0, noData = 0, fail = 0;
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async ({ symbol }) => {
      try {
        const rows = await fetchYahoo(symbol);
        if (rows.length === 0) { noData++; return; }
        await writeCandleFile(symbol, 'TW', rows);
        ok++;
      } catch {
        fail++;
      }
    }));
    if ((i / CONCURRENCY) % 5 === 0) {
      const pct = Math.round((i + CONCURRENCY) / missing.length * 100);
      process.stdout.write(`\r   ${Math.min(100, pct)}% ok=${ok} noData=${noData} fail=${fail}`);
    }
    await sleep(300);
  }
  console.log(`\n\n✅ ok=${ok} noData=${noData} fail=${fail}`);
}

main().catch(err => { console.error(err); process.exit(1); });
