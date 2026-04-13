/**
 * 用騰訊財經修復 13 支陸股過期 K 線（EastMoney 封鎖 Mac，但騰訊可連）
 * npx tsx scripts/repair-cn-via-tencent.ts
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { tencentHistProvider } from '../lib/datasource/TencentHistProvider';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';

// 騰訊確認有資料但本地過期的股票
const SYMBOLS = [
  '600837.SS', // 2025-02-05
  '601028.SS', // 2025-03-26
  '000040.SZ', // 2025-03-31
  '600705.SS', // 2025-04-02
  '600811.SS', // 2025-04-14
  '600804.SS', // 2025-06-30
  '000584.SZ', // 2025-07-10
  '000622.SZ', // 2025-07-15
  '601989.SS', // 2025-08-12
  '000627.SZ', // 2025-08-13
  '000851.SZ', // 2025-09-26
  '603056.SS', // 2026-01-20
  '600735.SS', // 2026-02-25
  // 下面兩支騰訊顯示已最新，也順便更新
  '002187.SZ',
  '000959.SZ',
];

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function main() {
  let ok = 0, fail = 0;
  const failed: string[] = [];

  console.log(`修復 ${SYMBOLS.length} 支 CN 過期股票（騰訊財經）...\n`);

  for (const sym of SYMBOLS) {
    try {
      const candles = await tencentHistProvider.getHistoricalCandles(sym, '2y');
      if (candles.length > 0) {
        await saveLocalCandles(sym, 'CN', candles);
        ok++;
        console.log(`✓ ${sym.padEnd(12)} ${candles.length} candles  last=${candles.at(-1)!.date}`);
      } else {
        fail++;
        failed.push(`${sym}(empty)`);
        console.log(`✗ ${sym.padEnd(12)} 空陣列`);
      }
    } catch (e) {
      fail++;
      const msg = (e as Error).message.slice(0, 60);
      failed.push(`${sym}(${msg})`);
      console.log(`✗ ${sym.padEnd(12)} ERROR: ${msg}`);
    }
    await sleep(500); // 騰訊較寬鬆
  }

  console.log(`\n完成: 成功=${ok} 失敗=${fail}`);
  if (failed.length) {
    console.log('失敗清單:');
    failed.forEach(f => console.log(' ', f));
  }
}

main().catch(console.error);
