/**
 * 統計過去 20 個交易日反轉軌+戰法軌訊號的戒律觸發分布
 *
 * 用法：
 *   npx tsx scripts/report-prohibition-distribution.ts
 *
 * 前提：先跑過 backfill-prohibition-history.ts 把過去 20 天 session 寫入
 *      longProhibitionsReasons 欄位
 *
 * 輸出：
 *   1. 每天 × 每 method 的「總訊號數 / 戒律觸發數」表
 *   2. 戒律類型分布（戒律 2/6/8/7/4 等）
 *   3. Top 戒律觸發股票（重複出現最多次）
 */
import { promises as fs } from 'fs';
import path from 'path';

import { REVERSAL_TRACK_LETTERS, SYSTEM_TRACK_LETTERS } from '../lib/scanner/buyMethodTracks';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const METHODS = [...REVERSAL_TRACK_LETTERS, ...SYSTEM_TRACK_LETTERS] as const;
const MARKETS = ['TW', 'CN'] as const;

interface ResultRow {
  symbol: string;
  name: string;
  matchedMethods?: string[];
  longProhibitionsReasons?: string[];
}

interface SessionFile {
  results?: ResultRow[];
}

async function loadSession(market: string, method: string, date: string): Promise<ResultRow[] | null> {
  const file = path.join(DATA_DIR, `scan-${market}-long-${method}-${date}.json`);
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf-8')) as SessionFile;
    return data.results ?? [];
  } catch {
    return null;
  }
}

async function listDates(market: string): Promise<string[]> {
  const entries = await fs.readdir(DATA_DIR);
  const re = new RegExp(`^scan-${market}-long-N-(\\d{4}-\\d{2}-\\d{2})`);
  const set = new Set<string>();
  for (const f of entries) {
    const m = f.match(re);
    if (m) set.add(m[1]);
  }
  return [...set].sort();
}

async function main(): Promise<void> {
  const twDates = await listDates('TW');
  const cnDates = await listDates('CN');
  const allDates = [...new Set([...twDates, ...cnDates])].sort();

  console.log(`\n========== 過去 ${allDates.length} 個交易日反轉軌+戰法軌戒律觸發分布 ==========\n`);

  // Per-day × per-method summary
  console.log('每日每 method 戒律觸發數（觸發數 / 總訊號數）：\n');
  console.log(`${'date'.padEnd(12)} ${'market'.padEnd(8)} ${'D'.padEnd(12)} ${'F'.padEnd(12)} ${'N'.padEnd(12)} ${'O'.padEnd(12)} ${'Q'.padEnd(12)}`);
  console.log('─'.repeat(80));

  const prohibitionCounter: Record<string, number> = {};
  const symbolCounter: Record<string, { name: string; count: number; markets: Set<string> }> = {};

  for (const date of allDates) {
    for (const market of MARKETS) {
      const row: string[] = [];
      for (const method of METHODS) {
        const results = await loadSession(market, method, date);
        if (results == null) { row.push('—'); continue; }
        const total = results.length;
        const prohib = results.filter(r => (r.longProhibitionsReasons?.length ?? 0) > 0);
        // Tally prohibition types + symbols
        for (const r of prohib) {
          for (const reason of r.longProhibitionsReasons ?? []) {
            const m = reason.match(/^(戒律\d+)/);
            const key = m ? m[1] : reason.slice(0, 10);
            prohibitionCounter[key] = (prohibitionCounter[key] ?? 0) + 1;
          }
          const k = `${market}:${r.symbol}`;
          if (!symbolCounter[k]) symbolCounter[k] = { name: r.name, count: 0, markets: new Set() };
          symbolCounter[k].count += 1;
          symbolCounter[k].markets.add(market);
        }
        row.push(`${prohib.length}/${total}`.padEnd(12));
      }
      console.log(`${date.padEnd(12)} ${market.padEnd(8)} ${row.join(' ')}`);
    }
  }

  // Prohibition type distribution
  console.log('\n戒律類型分布：');
  const sortedProhib = Object.entries(prohibitionCounter).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sortedProhib) {
    console.log(`  ${reason.padEnd(10)} ${count}`);
  }

  // Top symbols
  console.log('\n戒律觸發最多次的股票（Top 15）：');
  const sortedSyms = Object.entries(symbolCounter)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15);
  for (const [key, info] of sortedSyms) {
    const sym = key.split(':')[1];
    console.log(`  ${sym.padEnd(12)} ${info.name.padEnd(15)} 觸發 ${info.count} 次`);
  }

  // Totals
  const totalProhibCount = Object.values(prohibitionCounter).reduce((a, b) => a + b, 0);
  console.log(`\n總計：${Object.keys(symbolCounter).length} 支股票被戒律標記，${totalProhibCount} 次累積觸發\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
