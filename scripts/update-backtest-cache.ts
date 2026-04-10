/**
 * 更新 backtest-candles-cn.json — 從本地個股 K 線補上新資料
 *
 * Usage: npx tsx scripts/update-backtest-cache.ts
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import fs from 'fs';
import path from 'path';
import { loadLocalCandles, getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');

async function main() {
  console.log('讀取回測快取...');
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  const stocks = raw.stocks as Record<string, { name: string; candles: any[] }>;

  const symbols = Object.keys(stocks);
  console.log(`回測快取有 ${symbols.length} 支股票`);

  // 找最新日期
  let cacheLatest = '';
  for (const data of Object.values(stocks)) {
    if (data.candles?.length > 0) {
      const last = data.candles[data.candles.length - 1].date?.slice(0, 10) ?? '';
      if (last > cacheLatest) cacheLatest = last;
    }
  }
  console.log(`快取最新日期: ${cacheLatest}`);

  // 列出本地有哪些 CN 股票
  const candleDir = getLocalCandleDir('CN');
  let localFiles: string[] = [];
  try { localFiles = fs.readdirSync(candleDir).filter(f => f.endsWith('.json')); } catch {}
  console.log(`本地個股 K 線目錄: ${candleDir}`);
  console.log(`本地個股 K 線: ${localFiles.length} 支`);

  let updated = 0;
  let failed = 0;
  let noNew = 0;

  for (const sym of symbols) {
    const data = stocks[sym];
    if (!data.candles || data.candles.length < 10) continue;

    const lastDate = data.candles[data.candles.length - 1].date?.slice(0, 10) ?? '';
    if (lastDate >= '2026-04-09') { noNew++; continue; }

    try {
      const localCandles = await loadLocalCandles(sym, 'CN');
      if (!localCandles || localCandles.length === 0) continue;

      const localLatest = localCandles[localCandles.length - 1].date?.slice(0, 10) ?? '';
      if (localLatest <= lastDate) { noNew++; continue; }

      // 找新的 K 線
      const newCandles = localCandles.filter(c => {
        const d = c.date?.slice(0, 10) ?? '';
        return d > lastDate;
      });

      if (newCandles.length > 0) {
        // 只保留 OHLCV 欄位（跟原快取格式一致）
        const cleanCandles = newCandles.map(c => ({
          date: c.date,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        }));
        data.candles.push(...cleanCandles);
        updated++;
        if (updated <= 5) {
          console.log(`  ✓ ${sym} +${newCandles.length}根 (${lastDate} → ${localLatest})`);
        }
      }
    } catch {
      failed++;
    }
  }

  if (updated > 5) console.log(`  ... 還有 ${updated - 5} 支已更新`);

  console.log(`\n更新: ${updated} 支  無新資料: ${noNew} 支  失敗: ${failed} 支`);

  if (updated > 0) {
    // 確認新的最新日期
    let newLatest = '';
    for (const data of Object.values(stocks)) {
      if (data.candles?.length > 0) {
        const last = data.candles[data.candles.length - 1].date?.slice(0, 10) ?? '';
        if (last > newLatest) newLatest = last;
      }
    }
    console.log(`更新後最新日期: ${newLatest}`);
    console.log('寫入檔案...');
    fs.writeFileSync(cacheFile, JSON.stringify(raw));
    const size = (fs.statSync(cacheFile).size / 1024 / 1024).toFixed(1);
    console.log(`完成！檔案大小: ${size} MB`);
  } else {
    console.log('沒有需要更新的資料。');
  }
}

main().catch(console.error);
