/**
 * 修復未更新到最新日期的 TW 股票（共 214 支）
 * npx tsx scripts/repair-tw-lagging.ts
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';

const SYMBOLS = ['0050.TW','1103.TW','1108.TW','1109.TW','1213.TW','1227.TW','1231.TW','1232.TW','1234.TW','1235.TW','1236.TW','1256.TW','1307.TW','1325.TW','1339.TW','1416.TW','1423.TW','1439.TW','1443.TW','1453.TW','1454.TW','1455.TW','1456.TW','1460.TW','1464.TW','1467.TW','1471.TW','1525.TW','1527.TW','1532.TW','1535.TW','1538.TW','1539.TW','1541.TW','1558.TW','1560.TW','1568.TW','1583.TW','1589.TW','1590.TW','1612.TW','1616.TW','1726.TW','1730.TW','1732.TW','1733.TW','1776.TW','1783.TW','1809.TW','1907.TW','2012.TW','2015.TW','2029.TW','2030.TW','2035.TWO','2038.TW','2059.TW','2072.TW','2073.TWO','2106.TW','2114.TW','2115.TW','2206.TW','2207.TW','2227.TW','2231.TW','2248.TW','2250.TW','2321.TW','2373.TW','2390.TW','2415.TW','2420.TW','2424.TW','2436.TW','2444.TW','2458.TW','2480.TW','2482.TW','2505.TW','2535.TW','2537.TW','2538.TW','2543.TW','2548.TW','2597.TW','2606.TW','2612.TW','2705.TW','2727.TW','2739.TW','2849.TW','2901.TW','2905.TW','2915.TW','2939.TW','2949.TWO','3040.TW','3064.TWO','3086.TWO','3164.TW','3168.TW','3308.TW','3312.TW','3346.TW','3432.TW','3443.TW','3501.TW','3530.TW','3592.TW','3622.TW','3652.TW','3669.TW','3679.TW','3708.TW','4148.TW','4155.TW','4169.TW','4441.TW','4557.TW','4560.TW','4564.TW','4568.TWO','4571.TW','4583.TW','4590.TW','4737.TW','4755.TW','4807.TW','4912.TW','4935.TW','5007.TW','5215.TW','5222.TW','5345.TWO','5523.TWO','5538.TW','5601.TWO','5906.TW','5907.TW','6028.TWO','6177.TW','6183.TW','6184.TW','6189.TW','6201.TW','6225.TW','6230.TW','6243.TW','6283.TW','6449.TW','6477.TW','6491.TW','6526.TW','6533.TW','6552.TW','6585.TW','6614.TW','6669.TW','6671.TW','6689.TW','6753.TW','6754.TW','6768.TW','6771.TW','6776.TW','6782.TW','6794.TW','6799.TW','6831.TW','6862.TW','6901.TW','6908.TW','6916.TW','6921.TW','6928.TW','6931.TW','6949.TW','6965.TW','6969.TW','6994.TW','6997.TWO','7705.TW','7711.TW','7730.TW','7736.TW','7750.TW','7799.TW','7811.TWO','7822.TW','8067.TWO','8114.TW','8291.TWO','8367.TW','8404.TW','8454.TW','8466.TW','8476.TW','8478.TW','8499.TW','9110.TW','9902.TW','9905.TW','9912.TW','9919.TW','9925.TW','9928.TW','9929.TW','9935.TW','9937.TW','9942.TW','9944.TW','9946.TW','9955.TW'];

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function main() {
  const scanner = new TaiwanScanner();
  let ok = 0, fail = 0;
  const failed: string[] = [];

  console.log(`修復 ${SYMBOLS.length} 支 TW 落後股票...\n`);

  for (const sym of SYMBOLS) {
    try {
      const candles = await scanner.fetchCandles(sym);
      if (candles.length > 0) {
        await saveLocalCandles(sym, 'TW', candles);
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
    await sleep(7000);
  }

  console.log(`\n完成: 成功=${ok} 失敗=${fail}`);
  if (failed.length) {
    console.log('失敗清單:');
    failed.forEach(f => console.log(' ', f));
  }
}

main().catch(console.error);
