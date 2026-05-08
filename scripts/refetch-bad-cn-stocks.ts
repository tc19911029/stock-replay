/**
 * 重新抓取 CN 個股 L1（用 ChinaScanner.fetchCandles）
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const TARGETS = ['600118.SS', '600152.SS', '001203.SZ'];

interface Candle { date: string; open: number; high: number; low: number; close: number; volume?: number; }

async function refetch(scanner: ChinaScanner, symbol: string) {
  console.log(`[${symbol}] 抓取...`);
  try {
    const candles = await scanner.fetchCandles(symbol);
    if (!candles || candles.length < 30) return console.log(`  ✗ 太少 (${candles?.length})`);
    console.log(`  取得 ${candles.length} 根 K 棒, last=${candles[candles.length - 1].date}`);
    const filePath = path.join(REPO_ROOT, 'data/candles/CN', `${symbol}.json`);
    let beforeCandles: Candle[] = [];
    try {
      beforeCandles = (JSON.parse(await fs.readFile(filePath, 'utf-8')) as { candles: Candle[] }).candles;
    } catch { /* */ }
    const newDates = new Set(candles.map((c) => c.date));
    const oneYearAgo = candles[0].date;
    const merged = [
      ...beforeCandles.filter((c) => c.date < oneYearAgo && !newDates.has(c.date)),
      ...candles.map((c) => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const out = { symbol, lastDate: merged[merged.length - 1].date, updatedAt: new Date().toISOString(), candles: merged, sealedDate: merged[merged.length - 1].date };
    await fs.writeFile(filePath, JSON.stringify(out));
    console.log(`  ✓ ${beforeCandles.length} → ${merged.length}`);
  } catch (err) {
    console.log(`  ✗ ${err}`);
  }
}

async function main() {
  const scanner = new ChinaScanner();
  for (const sym of TARGETS) await refetch(scanner, sym);
}

main();
