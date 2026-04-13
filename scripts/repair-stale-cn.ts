/**
 * 一次性修復：重新下載 29 支本地過期的 CN K 線
 * npx tsx scripts/repair-stale-cn.ts
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';

const STALE_SYMBOLS = [
  '002089.SZ','000416.SZ','000961.SZ','600321.SS','000971.SZ',
  '000836.SZ','000982.SZ','000996.SZ','002087.SZ','002505.SZ',
  '600297.SS','000023.SZ','000976.SZ','000861.SZ','600837.SS',
  '601028.SS','000040.SZ','600705.SS','002187.SZ','600811.SS',
  '600804.SS','000584.SZ','000622.SZ','601989.SS','000627.SZ',
  '000851.SZ','603056.SS','600735.SS','000959.SZ',
];

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function main() {
  const scanner = new ChinaScanner();
  let ok = 0, fail = 0;
  const failed: string[] = [];

  console.log(`修復 ${STALE_SYMBOLS.length} 支 CN 過期股票...\n`);

  for (const sym of STALE_SYMBOLS) {
    try {
      const candles = await scanner.fetchCandles(sym);
      if (candles.length > 0) {
        await saveLocalCandles(sym, 'CN', candles);
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
    await sleep(500); // EastMoney 較寬鬆，500ms 足夠
  }

  console.log(`\n完成: 成功=${ok} 失敗=${fail}`);
  if (failed.length) {
    console.log('失敗清單:');
    failed.forEach(f => console.log(' ', f));
  }
}

main().catch(console.error);
