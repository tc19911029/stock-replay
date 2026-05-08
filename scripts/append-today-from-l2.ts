// 一次性：用本地 L2 snapshot 補今日 L1（繞過 route 的時間 gate）
// 用途：盤後窗口（CN 15:01-15:30）已過、但 L1 沒寫進去時手動補
// 執行：npx tsx scripts/append-today-from-l2.ts CN

import fs from 'node:fs/promises';
import path from 'node:path';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { suspectsLimitOverwrite } from '../lib/datasource/limitMoveGuard';
import { getLastTradingDay } from '../lib/datasource/marketHours';

const market = (process.argv[2] ?? 'CN') as 'TW' | 'CN';
const date = process.argv[3] ?? getLastTradingDay(market);

async function main() {
  console.log(`[append-today] market=${market} date=${date}`);

  const file = path.join(process.cwd(), 'data', `intraday-${market}-${date}.json`);
  const raw = await fs.readFile(file, 'utf-8');
  const json = JSON.parse(raw) as { quotes?: Array<{ symbol: string; open: number; high: number; low: number; close: number; volume: number }> };
  const quotes = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>();
  for (const q of json.quotes ?? []) {
    if (q.close > 0 && q.open > 0) {
      quotes.set(q.symbol, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
    }
  }
  console.log(`[append-today] L2 snapshot 讀到 ${quotes.size} 筆`);

  const scanner = market === 'TW'
    ? new (await import('../lib/scanner/TaiwanScanner')).TaiwanScanner()
    : new (await import('../lib/scanner/ChinaScanner')).ChinaScanner();
  const stocks = await scanner.getStockList();

  let appended = 0;
  let already = 0;
  let skipNoQuote = 0;
  let skipLimitUp = 0;

  await Promise.allSettled(stocks.map(async ({ symbol }) => {
    const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const existing = await readCandleFile(symbol, market);
    if (!existing) return;
    if (existing.lastDate >= date) { already++; return; }
    const q = quotes.get(code);
    if (!q) { skipNoQuote++; return; }

    const prev = existing.candles[existing.candles.length - 1];
    if (suspectsLimitOverwrite(prev?.close, q, market, code)) {
      skipLimitUp++;
      return;
    }

    await saveLocalCandles(symbol, market, [
      ...existing.candles,
      { date, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume },
    ]);
    appended++;
  }));

  console.log(`[append-today] ✅ 完成: appended=${appended} already=${already} skipNoQuote=${skipNoQuote} skipLimitUp=${skipLimitUp} total=${stocks.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
