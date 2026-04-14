/**
 * 修復資料斷層：掃描所有本地 TW K 線，找出 gap > 15 天的股票重新下載
 *
 * npx tsx scripts/repair-gap-stocks.ts
 * npx tsx scripts/repair-gap-stocks.ts --market CN
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import path from 'path';
import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { detectCandleGaps } from '../lib/datasource/validateCandles';
import { eodhdHistProvider } from '../lib/datasource/EODHDHistProvider';
import { yahooProvider } from '../lib/datasource/YahooDataProvider';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const market = process.argv.includes('--cn') || process.argv.includes('--market')
  ? (process.argv[process.argv.indexOf('--market') + 1] === 'CN' ? 'CN' : 'TW')
  : 'TW';

const MAX_GAP_DAYS = 15;
const DELAY_MS = 7000; // FinMind rate limit: 10/min → 7s interval

interface GapStock {
  symbol: string;
  file: string;
  gaps: Array<{ fromDate: string; toDate: string; calendarDays: number }>;
}

function scanForGaps(): GapStock[] {
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  if (!existsSync(dir)) {
    console.error(`目錄不存在: ${dir}`);
    return [];
  }

  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const result: GapStock[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(path.join(dir, file), 'utf-8');
      const data = JSON.parse(raw);
      const candles = data.candles as Array<{ date: string }>;
      if (!candles || candles.length < 30) continue;

      const gaps = detectCandleGaps(candles, MAX_GAP_DAYS);
      if (gaps.length > 0) {
        result.push({ symbol: data.symbol || file.replace('.json', ''), file, gaps });
      }
    } catch {
      // skip corrupted files
    }
  }

  return result;
}

async function main() {
  console.log(`=== 掃描 ${market} 本地 K 線資料斷層 (gap > ${MAX_GAP_DAYS} 天) ===\n`);

  const gapStocks = scanForGaps();
  if (gapStocks.length === 0) {
    console.log('沒有發現資料斷層，全部正常！');
    return;
  }

  console.log(`發現 ${gapStocks.length} 支有斷層:\n`);
  for (const gs of gapStocks) {
    const gapStr = gs.gaps.map(g => `${g.fromDate}→${g.toDate}(${g.calendarDays}天)`).join(', ');
    console.log(`  ${gs.symbol.padEnd(14)} ${gapStr}`);
  }

  console.log(`\n開始重新下載...\n`);

  const scanner = market === 'TW' ? new TaiwanScanner() : new ChinaScanner();
  let ok = 0, fail = 0, stillGap = 0;
  const failed: string[] = [];

  for (let i = 0; i < gapStocks.length; i++) {
    const gs = gapStocks[i];
    const progress = `[${i + 1}/${gapStocks.length}]`;

    try {
      // 嘗試順序：FinMind（TaiwanScanner）→ EODHD → Yahoo Finance
      let candles = await scanner.fetchCandles(gs.symbol).catch(() => []);

      let source = 'FinMind';
      if (candles.length < 30 && market === 'TW') {
        try {
          const eodhdCandles = await eodhdHistProvider.getHistoricalCandles(gs.symbol, '2y');
          if (eodhdCandles.length >= 30) {
            candles = eodhdCandles;
            source = 'EODHD';
          }
        } catch {
          // EODHD failed, try Yahoo
        }
      }

      if (candles.length < 30 && market === 'TW') {
        try {
          const yahooCandles = await yahooProvider.getHistoricalCandles(gs.symbol, '2y');
          if (yahooCandles.length >= 30) {
            candles = yahooCandles;
            source = 'Yahoo';
          }
        } catch {
          // Yahoo also failed
        }
      }

      if (candles.length >= 30) {
        await saveLocalCandles(gs.symbol, market as 'TW' | 'CN', candles);

        // 驗證 gap 是否消除
        const newGaps = detectCandleGaps(candles, MAX_GAP_DAYS);
        if (newGaps.length > 0) {
          stillGap++;
          const gapStr = newGaps.map(g => `${g.fromDate}→${g.toDate}(${g.calendarDays}天)`).join(', ');
          console.log(`△ ${progress} ${gs.symbol.padEnd(14)} [${source}] ${candles.length} candles  仍有斷層: ${gapStr}`);
        } else {
          ok++;
          console.log(`✓ ${progress} ${gs.symbol.padEnd(14)} [${source}] ${candles.length} candles  last=${candles.at(-1)!.date}  斷層已修復`);
        }
      } else {
        fail++;
        failed.push(`${gs.symbol}(${candles.length} candles)`);
        console.log(`✗ ${progress} ${gs.symbol.padEnd(14)} 只有 ${candles.length} candles（已下市？）`);
      }
    } catch (e) {
      fail++;
      const msg = (e as Error).message.slice(0, 80);
      failed.push(`${gs.symbol}(${msg})`);
      console.log(`✗ ${progress} ${gs.symbol.padEnd(14)} ERROR: ${msg}`);
    }

    if (i < gapStocks.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\n=== 完成 ===`);
  console.log(`修復成功: ${ok}`);
  console.log(`仍有斷層: ${stillGap}（資料源本身缺漏）`);
  console.log(`下載失敗: ${fail}`);
  if (failed.length) {
    console.log('\n失敗清單:');
    failed.forEach(f => console.log(`  ${f}`));
  }
}

main().catch(console.error);
