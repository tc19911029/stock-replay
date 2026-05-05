/**
 * 診斷 CN L1 資料缺口：哪些股票缺、缺多嚴重、為什麼
 *
 * 用法：npx tsx scripts/diagnose-cn-l1.ts
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { CN_STOCKS } from '../lib/scanner/cnStocks';

const CN_TEST = [
  '600519.SS', '601318.SS', '600036.SS', '601012.SS', '601398.SS',
  '600276.SS', '600900.SS', '601628.SS', '600030.SS', '601166.SS',
  '601888.SS', '600837.SS', '600000.SS', '601288.SS', '601988.SS',
  '600585.SS', '600028.SS', '600438.SS', '601857.SS', '600009.SS',
  '000001.SZ', '000002.SZ', '000333.SZ', '000651.SZ', '000725.SZ',
  '300750.SZ', '300059.SZ', '300015.SZ', '002594.SZ', '002415.SZ',
];

async function main() {
  console.log('=== CN L1 資料診斷 ===\n');

  // ── Part 1: mini scan 內 30 支詳細狀態 ──
  console.log('Part 1: 上輪 mini scan 30 支股票的 L1 狀態');
  let okCount = 0, missCount = 0;
  const missing: string[] = [];
  for (const symbol of CN_TEST) {
    const file = await readCandleFile(symbol, 'CN');
    if (!file || !file.candles || file.candles.length === 0) {
      missing.push(symbol);
      missCount++;
      continue;
    }
    const last = file.candles[file.candles.length - 1];
    const inActiveList = CN_STOCKS.find(s => s.symbol === symbol);
    okCount++;
    if (file.candles.length < 100) {
      console.log(`  ⚠️ ${symbol} (${inActiveList?.name ?? '?'}) → 僅 ${file.candles.length} 根 (last: ${last.date})`);
    }
  }
  console.log(`  OK: ${okCount} / 缺資料: ${missCount}\n`);

  if (missing.length > 0) {
    console.log(`  缺資料的股票（${missing.length}支）：`);
    for (const s of missing) {
      const inActiveList = CN_STOCKS.find(st => st.symbol === s);
      console.log(`    ${s} → ${inActiveList ? `在 active list (${inActiveList.name})` : '不在 active list（可能已退市/停牌）'}`);
    }
    console.log();
  }

  // ── Part 2: active CN list 整體覆蓋率（隨機抽 100 支）──
  console.log('Part 2: active CN list 整體覆蓋率（抽 100 支）');
  const sample = [...CN_STOCKS].sort(() => Math.random() - 0.5).slice(0, 100);
  let activeOk = 0, activeMiss = 0, activeStale = 0, activeFresh = 0;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const staleSamples: string[] = [];

  for (const { symbol, name } of sample) {
    const file = await readCandleFile(symbol, 'CN');
    if (!file || !file.candles || file.candles.length === 0) {
      activeMiss++;
      continue;
    }
    activeOk++;
    const last = file.candles[file.candles.length - 1].date;
    // 落後超過 5 個自然日視為 stale
    const lastMs = Date.parse(last + 'T12:00:00');
    const todayMs = Date.parse(today + 'T12:00:00');
    const daysBehind = (todayMs - lastMs) / 86400_000;
    if (daysBehind > 5) {
      activeStale++;
      if (staleSamples.length < 5) staleSamples.push(`${symbol} (${name}) → last ${last} (落後 ${Math.round(daysBehind)} 天)`);
    } else {
      activeFresh++;
    }
  }
  console.log(`  抽樣 100 支：覆蓋 ${activeOk} 支（${activeFresh} 新鮮 + ${activeStale} 落後 >5 天）/ 缺 ${activeMiss} 支`);
  console.log(`  覆蓋率 ${activeOk}% / 新鮮率 ${activeFresh}%`);

  if (staleSamples.length > 0) {
    console.log(`\n  落後股票樣本：`);
    staleSamples.forEach(s => console.log(`    ${s}`));
  }

  // ── Part 3: 對比 active list 大小 ──
  console.log(`\nPart 3: 整體狀態`);
  console.log(`  CN_STOCKS active list 大小: ${CN_STOCKS.length} 支`);
  console.log(`  本次抽樣覆蓋率: ${activeOk}% (基於 100 支隨機抽樣)`);

  if (activeMiss > 10) {
    console.log(`  ⚠️ 缺資料率 >10%，可能下載 cron 出問題`);
  } else if (activeStale > 20) {
    console.log(`  ⚠️ 落後率 >20%，可能下載 cron 排程不夠頻繁`);
  } else {
    console.log(`  ✅ 整體 L1 健康度良好`);
  }
}

main().catch(err => {
  console.error('腳本失敗:', err);
  process.exit(1);
});
