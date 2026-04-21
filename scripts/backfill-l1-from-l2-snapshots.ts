/**
 * 從已存的 L2 intraday 快照補填 L1 缺口
 *
 * 找出所有 data/intraday-{market}-{date}.json，
 * 對每支 L1 lastDate < date 的股票補入那天的 K 棒。
 *
 * 用法：
 *   npx tsx scripts/backfill-l1-from-l2-snapshots.ts
 *   npx tsx scripts/backfill-l1-from-l2-snapshots.ts --market TW
 *   npx tsx scripts/backfill-l1-from-l2-snapshots.ts --market CN --date 2026-04-21
 */

import { config } from 'dotenv';
import { existsSync, readdirSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';

const DATA_ROOT = path.join(process.cwd(), 'data');
const CANDLES_ROOT = path.join(DATA_ROOT, 'candles');

interface L2Quote {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface L2Snapshot {
  market: string;
  date: string;
  quotes: L2Quote[];
}

/** 掃描 data/candles/{market}/ 建立 code→fullSymbol map（例如 "4722" → "4722.TW"）*/
function buildCodeMap(market: 'TW' | 'CN'): Map<string, string> {
  const dir = path.join(CANDLES_ROOT, market);
  if (!existsSync(dir)) return new Map();
  const map = new Map<string, string>();
  for (const fname of readdirSync(dir)) {
    if (!fname.endsWith('.json')) continue;
    const sym = fname.replace('.json', ''); // e.g. "4722.TW"
    const code = sym.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    map.set(code, sym);
  }
  return map;
}

/** 找出所有可用的 L2 快照，依 market / date 過濾（不補今天及之後，避免污染未收盤資料） */
function findSnapshots(
  filterMarket?: string,
  filterDate?: string,
  maxDate?: string,
): Array<{ market: 'TW' | 'CN'; date: string; file: string }> {
  const results: Array<{ market: 'TW' | 'CN'; date: string; file: string }> = [];
  for (const fname of readdirSync(DATA_ROOT)) {
    const m = fname.match(/^intraday-(TW|CN)-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const market = m[1] as 'TW' | 'CN';
    const date = m[2];
    if (filterMarket && market !== filterMarket) continue;
    if (filterDate && date !== filterDate) continue;
    if (maxDate && date >= maxDate) continue; // 不補今天及之後
    results.push({ market, date, file: path.join(DATA_ROOT, fname) });
  }
  return results.sort((a, b) => `${a.market}${a.date}`.localeCompare(`${b.market}${b.date}`));
}

async function backfillSnapshot(
  market: 'TW' | 'CN',
  date: string,
  snapshotFile: string,
  codeMap: Map<string, string>,
): Promise<{ appended: number; already: number; noL1: number; noQuote: number; errors: number }> {
  const raw = await readFile(snapshotFile, 'utf-8');
  const snapshot: L2Snapshot = JSON.parse(raw);

  const quoteMap = new Map<string, L2Quote>();
  for (const q of snapshot.quotes) {
    if (q.close > 0) quoteMap.set(q.symbol, q);
  }

  const stats = { appended: 0, already: 0, noL1: 0, noQuote: 0, errors: 0 };

  const symbols = [...codeMap.values()];
  const CONCURRENCY = 80;

  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async (sym) => {
      try {
        const existing = await readCandleFile(sym, market);
        if (!existing) { stats.noL1++; return; }
        if (existing.lastDate >= date) { stats.already++; return; }

        const code = sym.replace(/\.(TW|TWO|SS|SZ)$/i, '');
        const q = quoteMap.get(code);
        if (!q) { stats.noQuote++; return; }

        // saveLocalCandles 內部會做 merge + volume sanity guard
        await saveLocalCandles(sym, market, [
          ...existing.candles,
          { date, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume },
        ]);
        stats.appended++;
      } catch {
        stats.errors++;
      }
    }));

    const pct = Math.min(100, Math.round(((i + CONCURRENCY) / symbols.length) * 100));
    process.stdout.write(`\r   進度: ${pct}%  (appended=${stats.appended})`);
  }
  process.stdout.write('\n');
  return stats;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let filterMarket: string | undefined;
  let filterDate: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--market' && i + 1 < args.length) { filterMarket = args[++i].toUpperCase(); }
    if (args[i] === '--date' && i + 1 < args.length) { filterDate = args[++i]; }
  }

  // 今天日期（CST）作為上限，避免把未收盤的盤中資料封存進 L1
  const todayCST = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).split(' ')[0];
  const snapshots = findSnapshots(filterMarket, filterDate, todayCST);
  if (snapshots.length === 0) {
    console.log('找不到符合條件的 L2 快照');
    return;
  }

  console.log(`找到 ${snapshots.length} 個快照：`);
  for (const s of snapshots) console.log(`  ${s.market} ${s.date}`);
  console.log('');

  // 預先建立兩個市場的 code map（只掃一次目錄）
  const twMap = buildCodeMap('TW');
  const cnMap = buildCodeMap('CN');
  console.log(`目錄掃描完成：TW=${twMap.size} 檔, CN=${cnMap.size} 檔\n`);

  let totalAppended = 0;
  let totalAlready = 0;

  for (const { market, date, file } of snapshots) {
    console.log(`▶ [${market}] 補 ${date} ...`);
    const codeMap = market === 'TW' ? twMap : cnMap;
    const stats = await backfillSnapshot(market, date, file, codeMap);
    console.log(
      `  ✅ appended=${stats.appended}  already=${stats.already}  noL1=${stats.noL1}  noQuote=${stats.noQuote}  errors=${stats.errors}`,
    );
    totalAppended += stats.appended;
    totalAlready += stats.already;
  }

  console.log(`\n🏁 全部完成：共補入 ${totalAppended} 筆，已有 ${totalAlready} 筆跳過`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
