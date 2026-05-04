/**
 * 重抓 000001.SS（上證指數）歷史 K 線，覆寫被誤路由到 000001.SZ（平安銀行）的污染檔。
 * 根因：cnSecid() 不分 .SS/.SZ，已在 EastMoneyHistProvider.ts 修補。
 */
import { config } from 'dotenv';
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { eastMoneyHistProvider } from '../lib/datasource/EastMoneyHistProvider';

async function main(): Promise<void> {
  const candles = await eastMoneyHistProvider.getHistoricalCandles('000001.SS', '2y');
  console.log(`📍 抓到 ${candles.length} 根 (${candles[0]?.date} ~ ${candles[candles.length - 1]?.date})`);
  console.log(`   first close: ${candles[0]?.close}  last close: ${candles[candles.length - 1]?.close}`);

  if (candles.length === 0 || (candles[0]?.close ?? 0) < 1000) {
    console.log('❌ 抓取結果不像指數（close < 1000），中止');
    process.exit(1);
  }

  // 直接寫檔（繞過 saveLocalCandles 的 guard，因為指數沒漲跌停限制）
  const stripped = candles.map(c => ({
    date: c.date, open: c.open, high: c.high,
    low: c.low, close: c.close, volume: c.volume,
  }));
  const out = {
    symbol: '000001.SS',
    lastDate: stripped[stripped.length - 1].date,
    updatedAt: new Date().toISOString(),
    candles: stripped,
    sealedDate: stripped[stripped.length - 1].date,
  };
  writeFileSync(path.join('data/candles/CN', '000001.SS.json'), JSON.stringify(out));
  console.log(`✅ 寫入 ${stripped.length} 筆`);
}

main().catch(err => { console.error(err); process.exit(1); });
