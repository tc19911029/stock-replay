// 一次性：從 L2 snapshot 把缺漏的中間日 K 棒插入 L1（正確位置，非 append）
// 用途：download-candles 漏抓某天但 L2 snapshot 有資料時補洞
// 執行：npx tsx scripts/insert-missing-day.ts TW 2026-05-06

import fs from 'node:fs/promises';
import path from 'node:path';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';

const market = (process.argv[2] ?? 'TW') as 'TW' | 'CN';
const date = process.argv[3];
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('用法：npx tsx scripts/insert-missing-day.ts TW 2026-05-06');
  process.exit(1);
}

async function main() {
  console.log(`[insert-missing] market=${market} date=${date}`);

  const file = path.join(process.cwd(), 'data', `intraday-${market}-${date}.json`);
  const raw = await fs.readFile(file, 'utf-8');
  const json = JSON.parse(raw) as { quotes?: Array<{ symbol: string; open: number; high: number; low: number; close: number; volume: number }> };
  const quotes = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>();
  for (const q of json.quotes ?? []) {
    if (q.close > 0 && q.open > 0) {
      quotes.set(q.symbol, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
    }
  }
  console.log(`[insert-missing] L2 snapshot 讀到 ${quotes.size} 筆`);

  const scanner = market === 'TW'
    ? new (await import('../lib/scanner/TaiwanScanner')).TaiwanScanner()
    : new (await import('../lib/scanner/ChinaScanner')).ChinaScanner();
  const stocks = await scanner.getStockList();

  let inserted = 0;
  let alreadyHasDate = 0;
  let skipNoQuote = 0;
  let skipNoExisting = 0;

  await Promise.allSettled(stocks.map(async ({ symbol }) => {
    const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const existing = await readCandleFile(symbol, market);
    if (!existing) { skipNoExisting++; return; }
    const candles = existing.candles;
    // 已有這天 → 跳過
    if (candles.some(c => c.date === date)) { alreadyHasDate++; return; }
    const q = quotes.get(code);
    if (!q) { skipNoQuote++; return; }

    // 找正確插入位置（保持日期升序）
    const idx = candles.findIndex(c => c.date > date);
    const newBar = { date, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume };
    const merged = idx === -1
      ? [...candles, newBar]
      : [...candles.slice(0, idx), newBar, ...candles.slice(idx)];

    await saveLocalCandles(symbol, market, merged);
    inserted++;
  }));

  console.log(`[insert-missing] ✅ 完成: inserted=${inserted} alreadyHasDate=${alreadyHasDate} skipNoQuote=${skipNoQuote} skipNoExisting=${skipNoExisting} total=${stocks.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
