/**
 * 修復 verify report 找到的近期 gap 股票
 * CN: 23 支（9-11 交易日缺口，2024-2026）
 * TW: 1 支（6120.TW，2025-09 缺 9 交易日）
 *
 * 策略：
 *   CN: EastMoney(2y) → Tencent(2y) → Yahoo(2y)
 *   TW: TWSEHist(2y) → FinMind(2y) → Yahoo(2y)
 *
 * npx tsx scripts/repair-gap-stocks-targeted.ts
 * npx tsx scripts/repair-gap-stocks-targeted.ts --market CN
 * npx tsx scripts/repair-gap-stocks-targeted.ts --market TW
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { writeCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { eastMoneyHistProvider } from '../lib/datasource/EastMoneyHistProvider';
import { tencentHistProvider } from '../lib/datasource/TencentHistProvider';
import { yahooProvider } from '../lib/datasource/YahooDataProvider';
import { TWSEHistProvider } from '../lib/datasource/TWSEHistProvider';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// 嚴格 3 交易日掃描找到的近期 gap（toDate >= 2025-11-01）
const CN_GAP_SYMBOLS = [
  '000592.SZ', '002131.SZ', '002462.SZ', '002667.SZ', '601020.SS', '605028.SS',
];

const TW_GAP_SYMBOLS = [
  '4169.TW', '6955.TW', '7716.TWO', '7780.TW', '7794.TWO',
  '7811.TWO', '7828.TWO', '8102.TWO', '8422.TW',
];

const marketArg = process.argv.includes('--market')
  ? (process.argv[process.argv.indexOf('--market') + 1] as 'TW' | 'CN')
  : null;

async function fetchCN(symbol: string): Promise<{ date: string; open: number; high: number; low: number; close: number; volume: number }[]> {
  // EastMoney/Tencent 都接受完整 symbol（605008.SS），內部自行解析後綴
  // 1. EastMoney
  try {
    const candles = await eastMoneyHistProvider.getHistoricalCandles(symbol, '2y');
    if (candles.length >= 100) { console.log(`  [EM] ${symbol}: ${candles.length} 根`); return candles; }
  } catch { /* fallthrough */ }

  // 2. Tencent
  try {
    const candles = await tencentHistProvider.getHistoricalCandles(symbol, '2y');
    if (candles.length >= 100) { console.log(`  [Tencent] ${symbol}: ${candles.length} 根`); return candles; }
  } catch { /* fallthrough */ }

  // 3. Yahoo
  try {
    const candles = await yahooProvider.getHistoricalCandles(symbol, '2y');
    if (candles.length >= 100) { console.log(`  [Yahoo] ${symbol}: ${candles.length} 根`); return candles; }
  } catch { /* fallthrough */ }

  return [];
}

const twseProvider = new TWSEHistProvider();

async function fetchTW(symbol: string): Promise<{ date: string; open: number; high: number; low: number; close: number; volume: number }[]> {
  // 1. TWSE/TPEx hist provider
  try {
    const candles = await twseProvider.getHistoricalCandles(symbol, '2y');
    if (candles.length >= 100) { console.log(`  [TWSE] ${symbol}: ${candles.length} 根`); return candles; }
  } catch { /* fallthrough */ }

  // 2. Yahoo
  try {
    const candles = await yahooProvider.getHistoricalCandles(symbol, '2y');
    if (candles.length >= 100) { console.log(`  [Yahoo] ${symbol}: ${candles.length} 根`); return candles; }
  } catch { /* fallthrough */ }

  return [];
}

async function main() {
  const tasks: Array<{ symbol: string; market: 'TW' | 'CN' }> = [];

  if (!marketArg || marketArg === 'CN') {
    for (const s of CN_GAP_SYMBOLS) tasks.push({ symbol: s, market: 'CN' });
  }
  if (!marketArg || marketArg === 'TW') {
    for (const s of TW_GAP_SYMBOLS) tasks.push({ symbol: s, market: 'TW' });
  }

  console.log(`\n=== 修復 ${tasks.length} 支 gap 股票 ===\n`);
  let ok = 0, fail = 0;
  const failed: string[] = [];

  for (const { symbol, market } of tasks) {
    process.stdout.write(`[${market}] ${symbol} ... `);
    try {
      const candles = market === 'CN'
        ? await fetchCN(symbol)
        : await fetchTW(symbol);

      if (candles.length === 0) {
        console.log(`❌ 所有資料源均失敗`);
        fail++;
        failed.push(symbol);
      } else {
        await writeCandleFile(symbol, market, candles);
        console.log(`✅ 已合併寫入`);
        ok++;
      }
    } catch (err) {
      console.log(`❌ ${(err as Error).message?.slice(0, 80)}`);
      fail++;
      failed.push(symbol);
    }

    await sleep(market === 'CN' ? 1500 : 500);
  }

  console.log(`\n=== 完成：✅ ${ok} 修復，❌ ${fail} 失敗 ===`);
  if (failed.length > 0) {
    console.log('失敗清單:', failed.join(', '));
  }
}

main().catch(console.error);
