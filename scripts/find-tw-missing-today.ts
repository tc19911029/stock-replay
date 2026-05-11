/**
 * 找出本地 TW L1 candle 檔案中 lastDate < expectedDate 的支
 *
 * 預設 expectedDate = 2026-05-11（今天 / 用 getLastTradingDay('TW')）
 * 用法：npx tsx scripts/find-tw-missing-today.ts [YYYY-MM-DD]
 *
 * 輸出：
 *   - stdout：每支 symbol, lastDate, past30Count, last5dates, inStocklist?, name
 *   - scripts/find-tw-missing-today-report.json
 */

import { promises as fs } from 'fs';
import path from 'path';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

interface CandleRow {
  date: string;
  open: number; high: number; low: number; close: number; volume: number;
}

interface CandleFile {
  symbol: string;
  lastDate: string;
  updatedAt?: string;
  sealedDate?: string;
  candles: CandleRow[];
}

interface MissingEntry {
  symbol: string;
  name?: string;
  lastDate: string;
  daysBehind: number;
  past30Count: number;
  last5Dates: string[];
  inStocklist: boolean;
  updatedAt?: string;
  sealedDate?: string;
}

const CANDLE_DIR = path.join(process.cwd(), 'data', 'candles', 'TW');
const REPORT_FILE = path.join(process.cwd(), 'scripts', 'find-tw-missing-today-report.json');

function businessDaysBetween(a: string, b: string): number {
  if (a >= b) return 0;
  const start = new Date(a + 'T00:00:00');
  const end = new Date(b + 'T00:00:00');
  let count = 0;
  const cursor = new Date(start);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor <= end) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

async function main(): Promise<void> {
  const argDate = process.argv[2];
  const expectedDate = argDate ?? getLastTradingDay('TW');
  console.log(`==> 預期最後交易日: ${expectedDate}`);

  // 1) Stocklist
  console.log('==> 抓 TW stocklist (TWSE + TPEx)...');
  let stocklistSet = new Set<string>();
  let stocklistNames = new Map<string, string>();
  try {
    const scanner = new TaiwanScanner();
    const stocks = await scanner.getStockList();
    for (const s of stocks) {
      stocklistSet.add(s.symbol);
      stocklistNames.set(s.symbol, s.name);
    }
    console.log(`   stocklist 大小: ${stocklistSet.size}`);
  } catch (err) {
    console.warn(`   stocklist 抓取失敗: ${err instanceof Error ? err.message : err}`);
  }

  // 2) 遍歷所有本地 TW candle 檔
  console.log('==> 遍歷 data/candles/TW/ 全部檔案...');
  const files = await fs.readdir(CANDLE_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json'));
  console.log(`   找到 ${jsonFiles.length} 個檔案`);

  const missing: MissingEntry[] = [];
  let okCount = 0;
  let errCount = 0;

  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(CANDLE_DIR, file), 'utf-8');
      const data: CandleFile = JSON.parse(raw);
      if (data.lastDate >= expectedDate) {
        okCount++;
        continue;
      }
      const candles = data.candles ?? [];
      const last5 = candles.slice(-5).map(c => c.date);
      // past30: 最近 30 個自然日內有幾根 K 棒
      const thirtyDaysAgo = new Date(expectedDate + 'T00:00:00');
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const cutoff = thirtyDaysAgo.toISOString().slice(0, 10);
      const past30Count = candles.filter(c => c.date >= cutoff).length;
      missing.push({
        symbol: data.symbol,
        name: stocklistNames.get(data.symbol),
        lastDate: data.lastDate,
        daysBehind: businessDaysBetween(data.lastDate, expectedDate),
        past30Count,
        last5Dates: last5,
        inStocklist: stocklistSet.has(data.symbol),
        updatedAt: data.updatedAt,
        sealedDate: data.sealedDate,
      });
    } catch (err) {
      errCount++;
      console.warn(`   讀取失敗 ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 排序：先 inStocklist + 最少 daysBehind，後 stale 的
  missing.sort((a, b) => {
    if (a.inStocklist !== b.inStocklist) return a.inStocklist ? -1 : 1;
    if (a.daysBehind !== b.daysBehind) return a.daysBehind - b.daysBehind;
    return a.symbol.localeCompare(b.symbol);
  });

  // 3) 輸出
  const inStocklistCount = missing.filter(m => m.inStocklist).length;
  console.log(`\n=== 結果 ===`);
  console.log(`OK (lastDate >= ${expectedDate}): ${okCount}`);
  console.log(`讀取錯誤: ${errCount}`);
  console.log(`Missing (lastDate < ${expectedDate}): ${missing.length}`);
  console.log(`  之中 inStocklist: ${inStocklistCount}（這些是需要修的）`);
  console.log(`  之中 NOT inStocklist: ${missing.length - inStocklistCount}（已退市或非追蹤目標）\n`);

  console.log('Symbol     | Name             | lastDate   | daysBehind | past30 | inList | last5');
  console.log('-----------|------------------|------------|------------|--------|--------|---------------------');
  for (const m of missing.slice(0, 60)) {
    const name = (m.name ?? '?').padEnd(16).slice(0, 16);
    const last5 = m.last5Dates.join(',');
    console.log(
      `${m.symbol.padEnd(10)} | ${name} | ${m.lastDate} | ${String(m.daysBehind).padStart(10)} | ` +
      `${String(m.past30Count).padStart(6)} | ${m.inStocklist ? '  Y   ' : '  -   '} | ${last5}`
    );
  }
  if (missing.length > 60) console.log(`... 還有 ${missing.length - 60} 支未顯示，看 JSON 報告`);

  // 4) 讀今天 manifest
  try {
    const manifestPath = path.join(process.cwd(), 'data', 'manifest', `TW-${expectedDate}.json`);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    console.log(`\n=== 今天 (${expectedDate}) cron manifest ===`);
    console.log(JSON.stringify(manifest, null, 2));
  } catch {
    console.log(`\n(找不到 ${expectedDate} 的 manifest)`);
  }

  // 5) 寫報告
  await fs.writeFile(REPORT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    expectedDate,
    okCount,
    errCount,
    missing,
    summary: {
      total: missing.length,
      inStocklist: inStocklistCount,
      notInStocklist: missing.length - inStocklistCount,
    },
  }, null, 2));
  console.log(`\n報告已寫到：${REPORT_FILE}`);
}

main().catch(err => { console.error(err); process.exit(1); });
