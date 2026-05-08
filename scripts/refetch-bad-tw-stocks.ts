/**
 * 重新抓取資料有問題的 TW 個股 L1 全歷史（覆寫本地）
 *
 * 用於修復：
 *   - 8476.TW：隨機切換 1x/2x close 價（資料源 split 對齊錯誤）
 *   - 7716.TWO / 7821.TW：近 90 天多日 K 棒缺漏
 *
 * 三層 fallback：TWSE/TPEx → FinMind → Yahoo
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { twseHistProvider } from '../lib/datasource/TWSEHistProvider';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';

interface Candle { date: string; open: number; high: number; low: number; close: number; volume?: number; }

const TARGETS = ['8476.TW', '7716.TWO', '7821.TW'];

async function refetch(symbol: string): Promise<{ ok: boolean; before?: number; after: number; reason?: string }> {
  console.log(`\n[${symbol}] 抓取最新 1y...`);
  try {
    const candles = await twseHistProvider.getHistoricalCandles(symbol, '3y');
    if (!candles || candles.length < 30) {
      return { ok: false, after: 0, reason: `太少 candles (${candles?.length ?? 0})` };
    }
    console.log(`  取得 ${candles.length} 根 K 棒, last=${candles[candles.length - 1].date}`);

    const filePath = path.join(REPO_ROOT, 'data', 'candles', 'TW', `${symbol}.json`);
    let beforeCount = 0;
    let beforeCandles: Candle[] = [];
    try {
      const old = JSON.parse(await fs.readFile(filePath, 'utf-8')) as { candles: Candle[] };
      beforeCount = old.candles.length;
      beforeCandles = old.candles;
    } catch { /* file doesn't exist */ }

    // 合併策略：用新抓的 1y 覆寫對應日期，老資料中 1y 之前的保留
    const newDates = new Set(candles.map((c) => c.date));
    const oneYearAgo = candles[0].date;
    const merged = [
      ...beforeCandles.filter((c) => c.date < oneYearAgo && !newDates.has(c.date)),
      ...candles.map((c) => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
    ].sort((a, b) => a.date.localeCompare(b.date));

    const out = {
      symbol,
      lastDate: merged[merged.length - 1].date,
      updatedAt: new Date().toISOString(),
      candles: merged,
      sealedDate: merged[merged.length - 1].date,
    };

    await fs.writeFile(filePath, JSON.stringify(out));
    return { ok: true, before: beforeCount, after: merged.length };
  } catch (err) {
    return { ok: false, after: 0, reason: String(err).slice(0, 200) };
  }
}

async function main() {
  for (const sym of TARGETS) {
    const r = await refetch(sym);
    if (r.ok) console.log(`  ✓ ${sym}: ${r.before} → ${r.after} candles`);
    else console.log(`  ✗ ${sym}: ${r.reason}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
