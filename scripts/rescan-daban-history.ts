/**
 * 用本地 K 線重掃所有歷史打板 session，覆蓋 Blob 上的錯誤資料
 *
 * Usage: npx tsx scripts/rescan-daban-history.ts
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';
import { scanDaban } from '@/lib/scanner/DabanScanner';
import { saveDabanSession } from '@/lib/storage/dabanStorage';

async function main() {
  const localDir = path.join(process.cwd(), 'data', 'candles', 'CN');

  // 載入所有本地 K 線
  console.log('載入本地 K 線...');
  const files = fs.readdirSync(localDir).filter(f => f.endsWith('.json'));
  const allStocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();

  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(localDir, f), 'utf-8'));
      if (!raw.candles || raw.candles.length < 30) continue;
      const sym = f.replace('.json', '');
      allStocks.set(sym, { name: raw.symbol || sym, candles: computeIndicators(raw.candles) });
    } catch { /* skip */ }
  }
  console.log(`載入 ${allStocks.size} 支股票\n`);

  // 取得所有交易日（用 000001.SZ 作為基準）
  const bench = allStocks.get('000001.SZ');
  if (!bench) { console.error('找不到 000001.SZ'); return; }

  const allDates = bench.candles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= '2025-04-01');

  console.log(`交易日範圍: ${allDates[0]} ~ ${allDates[allDates.length - 1]} (${allDates.length} 天)\n`);

  let saved = 0;
  let errors = 0;

  for (const date of allDates) {
    try {
      const session = scanDaban({ stocks: allStocks, date });

      if (session.results.length === 0) continue;

      await saveDabanSession(session);
      saved++;

      const sentiment = session.sentiment;
      const sentLabel = sentiment?.isCold ? '❄️' : '✅';
      console.log(
        `${sentLabel} ${date}: ${session.results.length} 檔漲停` +
        (sentiment ? ` (漲停${sentiment.limitUpCount}家, 昨漲停今均${sentiment.yesterdayAvgReturn >= 0 ? '+' : ''}${sentiment.yesterdayAvgReturn}%)` : '')
      );
    } catch (e) {
      errors++;
      console.error(`❌ ${date}: ${e}`);
    }
  }

  console.log(`\n完成: 已重掃 ${saved} 天, 錯誤 ${errors} 天`);
}

main().catch(console.error);
