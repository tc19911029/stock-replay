/**
 * 驗證本地 K 線資料的日期是否落在合法交易日
 * 偵測：週末K線、假日K線（清明/春節/勞動節等）
 * npx tsx scripts/validate-trading-dates.ts [TW|CN]
 */
import { existsSync, readdirSync } from 'fs';
import { config } from 'dotenv';
if (existsSync('.env.local')) config({ path: '.env.local' });

import { readLocalCandles } from '../lib/datasource/LocalCandleStore';
import { isTradingDay } from '../lib/utils/tradingDay';

type Market = 'TW' | 'CN';

async function main() {
  const market = (process.argv[2] as Market) || 'TW';
  if (market !== 'TW' && market !== 'CN') {
    console.error('Usage: npx tsx scripts/validate-trading-dates.ts [TW|CN]');
    process.exit(1);
  }

  const dir = `data/candles/${market}`;
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));

  console.log(`🔍 驗證 ${market} 市場 ${files.length} 支股票的交易日...\n`);

  let totalViolations = 0;
  const violations: Array<{ symbol: string; date: string; reason: string }> = [];

  for (const file of files) {
    const symbol = file.replace('.json', '');
    try {
      const candles = await readLocalCandles(symbol, market);
      if (!candles || candles.length === 0) continue;

      for (const candle of candles) {
        if (!isTradingDay(candle.date, market)) {
          const d = new Date(candle.date + 'T12:00:00');
          const dayName = ['日','一','二','三','四','五','六'][d.getDay()];
          const reason = (d.getDay() === 0 || d.getDay() === 6)
            ? `週${dayName}（非交易日）`
            : '假日';
          violations.push({ symbol, date: candle.date, reason });
          totalViolations++;
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  if (totalViolations === 0) {
    console.log(`✅ 全部 ${files.length} 支股票無日期異常！`);
  } else {
    console.log(`⚠️  發現 ${totalViolations} 筆日期落在非交易日：\n`);
    // Group by date for summary
    const byDate = new Map<string, string[]>();
    for (const v of violations) {
      if (!byDate.has(v.date)) byDate.set(v.date, []);
      byDate.get(v.date)!.push(v.symbol);
    }
    for (const [date, syms] of [...byDate.entries()].sort()) {
      const d = new Date(date + 'T12:00:00');
      const dayName = ['日','一','二','三','四','五','六'][d.getDay()];
      console.log(`  ${date} 週${dayName}: ${syms.length} 支`);
      if (syms.length <= 10) {
        syms.forEach(s => console.log(`    - ${s}`));
      } else {
        syms.slice(0, 5).forEach(s => console.log(`    - ${s}`));
        console.log(`    ... 及另外 ${syms.length - 5} 支`);
      }
    }
    console.log(`\n共 ${totalViolations} 筆，涉及 ${byDate.size} 個日期`);
  }
}

main().catch(console.error);
