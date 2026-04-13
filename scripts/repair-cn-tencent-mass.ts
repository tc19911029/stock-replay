/**
 * 用騰訊財經全量更新所有未到最新日期的 CN 股票
 * npx tsx scripts/repair-cn-tencent-mass.ts [targetDate]
 * 例：npx tsx scripts/repair-cn-tencent-mass.ts 2026-04-13
 */
import { config } from 'dotenv';
import { existsSync, readdirSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { readFileSync } from 'fs';
import { tencentHistProvider } from '../lib/datasource/TencentHistProvider';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';

const TARGET_DATE = process.argv[2] || '2026-04-13';
const DELAY_MS = 500; // 騰訊較寬鬆

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function main() {
  // 直接讀 JSON 找出所有未到 TARGET_DATE 的 CN 股票（繞過 readLocalCandles 快取）
  const dir = 'data/candles/CN';
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));

  const toUpdate: string[] = [];
  for (const file of files) {
    const symbol = file.replace('.json', '');
    try {
      const raw = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
      const lastDate: string = raw.lastDate || raw.candles?.at(-1)?.date || '';
      if (lastDate && lastDate < TARGET_DATE) {
        toUpdate.push(symbol);
      }
    } catch { /* skip */ }
  }

  console.log(`📥 目標日期: ${TARGET_DATE}`);
  console.log(`📋 需更新: ${toUpdate.length} 支\n`);

  let ok = 0, fail = 0, skip = 0;
  const failed: string[] = [];

  for (let i = 0; i < toUpdate.length; i++) {
    const sym = toUpdate[i];
    try {
      const candles = await tencentHistProvider.getHistoricalCandles(sym, '2y');
      if (candles.length > 0) {
        const lastDate = candles[candles.length - 1].date;
        if (lastDate >= TARGET_DATE) {
          await saveLocalCandles(sym, 'CN', candles);
          ok++;
          if (ok % 50 === 0 || i < 5) {
            console.log(`✓ [${i+1}/${toUpdate.length}] ${sym.padEnd(12)} ${candles.length} candles  last=${lastDate}`);
          }
        } else {
          // 騰訊也沒有更新的資料（停牌）
          skip++;
          if (skip <= 5) console.log(`⏭ ${sym.padEnd(12)} 停牌中 last=${lastDate}`);
        }
      } else {
        fail++;
        failed.push(`${sym}(empty)`);
      }
    } catch (e) {
      fail++;
      const msg = (e as Error).message.slice(0, 50);
      failed.push(`${sym}(${msg})`);
      if (fail <= 10) console.log(`✗ ${sym.padEnd(12)} ${msg}`);
    }
    await sleep(DELAY_MS);

    // 每 200 支顯示進度
    if ((i + 1) % 200 === 0) {
      console.log(`\n📊 進度 ${i+1}/${toUpdate.length}: 成功=${ok} 跳過=${skip} 失敗=${fail}\n`);
    }
  }

  console.log(`\n✅ 完成: 成功=${ok} 停牌跳過=${skip} 失敗=${fail}`);
  if (failed.length > 0) {
    console.log('失敗清單（前20）:');
    failed.slice(0, 20).forEach(f => console.log(' ', f));
  }
}

main().catch(console.error);
