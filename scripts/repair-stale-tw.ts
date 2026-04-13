/**
 * 一次性修復：重新下載 50 支本地過期的 TW K 線
 * npx tsx scripts/repair-stale-tw.ts
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';

// 37 支仍過期（FinMind rate limit 導致前次失敗，需 7s 間隔）
const STALE_SYMBOLS = [
  '1614.TW','2109.TW','2364.TW','2438.TW','2514.TW','2545.TW',
  '2832.TW','2923.TW','6128.TW','6216.TW','6657.TW','6914.TW','9930.TW',
  '1321.TW','1451.TW','2483.TW','2506.TW','2704.TW','3257.TW',
  '3311.TW','4771.TW','5203.TW','6790.TW',
  '1438.TW','1760.TW','2707.TW','4439.TW','5288.TW','5533.TW',
  '6281.TW','6923.TW',
  '3018.TW','6236.TWO','1446.TW','4536.TW','6666.TW','6796.TW',
];

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function main() {
  const scanner = new TaiwanScanner();
  let ok = 0, fail = 0;
  const failed: string[] = [];

  console.log(`修復 ${STALE_SYMBOLS.length} 支過期股票...\n`);

  for (const sym of STALE_SYMBOLS) {
    try {
      const candles = await scanner.fetchCandles(sym);
      if (candles.length > 0) {
        await saveLocalCandles(sym, 'TW', candles);
        ok++;
        console.log(`✓ ${sym.padEnd(12)} ${candles.length} candles  last=${candles.at(-1)!.date}`);
      } else {
        fail++;
        failed.push(`${sym}(empty)`);
        console.log(`✗ ${sym.padEnd(12)} 空陣列（已下市？）`);
      }
    } catch (e) {
      fail++;
      const msg = (e as Error).message.slice(0, 60);
      failed.push(`${sym}(${msg})`);
      console.log(`✗ ${sym.padEnd(12)} ERROR: ${msg}`);
    }
    await sleep(7000); // FinMind 600/hr = 10/min，7s 間隔保持在限額內
  }

  console.log(`\n完成: 成功=${ok} 失敗=${fail}`);
  if (failed.length) {
    console.log('失敗清單:');
    failed.forEach(f => console.log(' ', f));
  }
}

main().catch(console.error);
