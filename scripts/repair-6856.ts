import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { yahooProvider } from '../lib/datasource/YahooDataProvider';
import { writeCandleFile } from '../lib/datasource/CandleStorageAdapter';

async function main() {
  const sym = '6856.TWO';
  const candles = await yahooProvider.getHistoricalCandles(sym, '2y');
  console.log(`${sym}: ${candles.length} candles, last=${candles.at(-1)?.date}`);
  if (candles.length >= 200) {
    await writeCandleFile(sym, 'TW', candles);
    console.log('✅ saved');
  } else {
    console.log('❌ too few candles');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
