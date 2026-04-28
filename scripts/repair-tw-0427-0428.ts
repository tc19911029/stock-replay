/**
 * 補抓 TW + TWO 04/27 / 04/28 缺漏 K 棒（用 FinMind）
 *
 * 緣由：
 * - TPEx 整個 endpoint 被 Cloudflare 403 → 883 支 .TWO 全缺 04/27, 04/28
 * - TWSE batch 4 (6xxx-) 4/27, 4/28 各有 ~82 支沒抓到
 *
 * FinMind dataset=TaiwanStockPrice 上市/上櫃通用，stock_id 不帶後綴。
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { writeCandleFile } from '../lib/datasource/CandleStorageAdapter';

const TOKEN = process.env.FINMIND_API_TOKEN ?? '';
const START_DATE = '2026-04-25';
const END_DATE = '2026-04-28';
const TARGET_LAST_DATE = '2026-04-28';
const CONCURRENCY = 8;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface FinMindRow {
  date: string;
  Trading_Volume: number;
  open: number;
  max: number;
  min: number;
  close: number;
}

async function fetchFromFinMind(code: string): Promise<{ date: string; open: number; high: number; low: number; close: number; volume: number }[]> {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${code}&start_date=${START_DATE}&end_date=${END_DATE}${TOKEN ? `&token=${TOKEN}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { status: number; data?: FinMindRow[] };
  if (json.status !== 200 || !json.data) return [];
  return json.data.map(r => ({
    date: r.date,
    open: r.open,
    high: r.max,
    low: r.min,
    close: r.close,
    volume: Math.round(r.Trading_Volume / 1000), // 股 → 張
  }));
}

async function findMissing(): Promise<{ symbol: string; pureCode: string; lastDate: string }[]> {
  const dir = path.join('data', 'candles', 'TW');
  const files = await fs.readdir(dir);
  const missing: { symbol: string; pureCode: string; lastDate: string }[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as { candles: { date: string }[] };
      if (!j.candles || j.candles.length === 0) continue;
      const last = j.candles[j.candles.length - 1].date;
      if (last < TARGET_LAST_DATE) {
        const symbol = f.replace('.json', '');
        const pureCode = symbol.replace(/\.(TW|TWO)$/i, '');
        missing.push({ symbol, pureCode, lastDate: last });
      }
    } catch { /* skip */ }
  }
  return missing;
}

async function main() {
  console.log(`📍 Token: ${TOKEN ? 'present' : 'missing'}`);
  console.log(`📍 目標範圍: ${START_DATE} ~ ${END_DATE}`);

  const missing = await findMissing();
  console.log(`🔍 找到 ${missing.length} 支需要補抓\n`);

  // 顯示前 5 支樣本
  for (const m of missing.slice(0, 5)) {
    console.log(`   ${m.symbol}: lastDate=${m.lastDate}`);
  }
  if (missing.length > 5) console.log(`   ... 共 ${missing.length} 支\n`);

  let ok = 0, noData = 0, fail = 0;
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async ({ symbol, pureCode }) => {
      try {
        const rows = await fetchFromFinMind(pureCode);
        if (rows.length === 0) { noData++; return; }
        await writeCandleFile(symbol, 'TW', rows);
        ok++;
      } catch {
        fail++;
      }
    }));
    if ((i / CONCURRENCY) % 5 === 0) {
      const pct = Math.round((i + CONCURRENCY) / missing.length * 100);
      process.stdout.write(`\r   進度: ${Math.min(100, pct)}% (ok=${ok} noData=${noData} fail=${fail})`);
    }
    await sleep(200); // gentle pacing
  }
  console.log(`\n\n✅ 完成：ok=${ok} noData=${noData} fail=${fail}`);
}

main().catch(err => { console.error(err); process.exit(1); });
