/**
 * 檢查 K 線資料在其涵蓋期間內是否有缺漏的交易日
 * npx tsx scripts/check-missing-trading-days.ts [TW|CN]
 *
 * 方法：對每支股票的第一根K線到最後一根K線之間，
 * 找出所有交易日，確認每個交易日都有對應K線。
 */
import { existsSync, readdirSync } from 'fs';
import { config } from 'dotenv';
if (existsSync('.env.local')) config({ path: '.env.local' });

import { readLocalCandles } from '../lib/datasource/LocalCandleStore';
import { isTradingDay } from '../lib/utils/tradingDay';

type Market = 'TW' | 'CN';

function getAllTradingDaysBetween(start: string, end: string, market: Market): string[] {
  const days: string[] = [];
  const cur = new Date(start + 'T12:00:00');
  const endDate = new Date(end + 'T12:00:00');
  while (cur <= endDate) {
    const ds = cur.toISOString().split('T')[0];
    if (isTradingDay(ds, market)) days.push(ds);
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

async function main() {
  const market = (process.argv[2] as Market) || 'TW';
  if (market !== 'TW' && market !== 'CN') {
    console.error('Usage: npx tsx scripts/check-missing-trading-days.ts [TW|CN]');
    process.exit(1);
  }

  const dir = `data/candles/${market}`;
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));

  console.log(`🔍 檢查 ${market} 市場 ${files.length} 支股票的交易日缺漏...\n`);

  // 假日曆只涵蓋 2025-2026，所以只檢查 2025-01-01 以後的區間
  const CHECK_START = '2025-01-01';

  let stocksWithGaps = 0;
  let totalMissingDays = 0;
  const summary: Array<{ symbol: string; missing: string[] }> = [];

  for (const file of files) {
    const symbol = file.replace('.json', '');
    try {
      const candles = await readLocalCandles(symbol, market);
      if (!candles || candles.length < 5) continue;

      const dates = new Set(candles.map(c => c.date));
      const rangeStart = candles[0].date < CHECK_START ? CHECK_START : candles[0].date;
      const rangeEnd = candles[candles.length - 1].date;

      const expected = getAllTradingDaysBetween(rangeStart, rangeEnd, market);
      const missing = expected.filter(d => !dates.has(d));

      if (missing.length > 0) {
        stocksWithGaps++;
        totalMissingDays += missing.length;
        summary.push({ symbol, missing });
      }
    } catch {
      // skip
    }
  }

  if (stocksWithGaps === 0) {
    console.log(`✅ 全部 ${files.length} 支股票在 ${CHECK_START} 後無缺漏交易日！`);
  } else {
    console.log(`⚠️  ${stocksWithGaps} 支股票有缺漏，共 ${totalMissingDays} 個交易日缺失\n`);

    // 按缺漏天數排序，顯示最嚴重的
    summary.sort((a, b) => b.missing.length - a.missing.length);
    console.log('缺漏最多的 30 支：');
    for (const { symbol, missing } of summary.slice(0, 30)) {
      console.log(`  ${symbol.padEnd(12)} 缺 ${missing.length} 天: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '...' : ''}`);
    }

    // 統計：哪些日期最多股票缺漏（可能是系統性問題）
    const dayCount = new Map<string, number>();
    for (const { missing } of summary) {
      for (const d of missing) {
        dayCount.set(d, (dayCount.get(d) || 0) + 1);
      }
    }
    const topDays = [...dayCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    console.log('\n最常缺漏的交易日（系統性問題）：');
    for (const [date, count] of topDays) {
      console.log(`  ${date}: ${count} 支股票缺漏`);
    }
  }
}

main().catch(console.error);
