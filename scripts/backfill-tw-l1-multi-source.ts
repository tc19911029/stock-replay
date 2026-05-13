/**
 * 補填 TW L1 指定日期 — 用 MultiMarketProvider fallback chain（FinMind/EODHD/TWSE/Yahoo）
 *
 * 適用：backfill-tw-l1-date.ts 跑完後仍有缺（多為上櫃）的 891 檔。
 *
 * 用法：
 *   npx tsx scripts/backfill-tw-l1-multi-source.ts --date 2026-05-12
 *   npx tsx scripts/backfill-tw-l1-multi-source.ts --date 2026-05-12 --limit 50 --dry
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { dataProvider } from '../lib/datasource/MultiMarketProvider';

interface Args { date: string; dry: boolean; limit: number; concurrency: number; }
function parseArgs(): Args {
  const args: Args = { date: '', dry: false, limit: Infinity, concurrency: 6 };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--date') args.date = process.argv[++i];
    else if (a === '--dry') args.dry = true;
    else if (a === '--limit') args.limit = parseInt(process.argv[++i], 10);
    else if (a === '--concurrency') args.concurrency = parseInt(process.argv[++i], 10);
  }
  if (!args.date) {
    console.error('Usage: --date YYYY-MM-DD [--dry] [--limit N] [--concurrency N]');
    process.exit(1);
  }
  return args;
}

async function main() {
  const { date, dry, limit, concurrency } = parseArgs();
  console.log(`目標日期: ${date} ${dry ? '(DRY)' : ''} limit=${limit} concurrency=${concurrency}`);

  // 找出 lastDate < date 的 L1 檔案
  const candleDir = path.join(process.cwd(), 'data', 'candles', 'TW');
  const todo: { sym: string; lastDate: string }[] = [];
  for (const f of readdirSync(candleDir)) {
    if (!f.endsWith('.json')) continue;
    const sym = f.replace('.json', '');
    try {
      const raw = JSON.parse(readFileSync(path.join(candleDir, f), 'utf8'));
      const candles = Array.isArray(raw) ? raw : (raw.candles || []);
      if (candles.length === 0) continue;
      const lastDate = candles[candles.length - 1].date;
      if (lastDate < date) todo.push({ sym, lastDate });
    } catch { continue; }
    if (todo.length >= limit) break;
  }
  console.log(`待處理 ${todo.length} 檔`);

  // 為了拿到 5/12 那筆 K，抓近 1 個月區間
  const start = new Date(date);
  start.setDate(start.getDate() - 30);
  const startStr = start.toISOString().split('T')[0];

  let written = 0, missing = 0, errors = 0;
  let processed = 0;

  // 並行 pool（簡單版）
  async function processOne(item: { sym: string; lastDate: string }) {
    const { sym } = item;
    try {
      const range = await dataProvider.getCandlesRange(sym, 'TW', startStr, date);
      const target = range.find(c => c.date === date);
      if (!target) {
        missing++;
        return;
      }
      if (!dry) {
        await saveLocalCandles(sym, 'TW', [target]);
      }
      written++;
      if (written <= 5 || written % 50 === 0) {
        console.log(`  ${written}: ${sym} ${date} O=${target.open} H=${target.high} L=${target.low} C=${target.close} V=${target.volume}`);
      }
    } catch (err) {
      errors++;
      if (errors <= 3) console.warn(`  ${sym}: ${err instanceof Error ? err.message : err}`);
    } finally {
      processed++;
      if (processed % 100 === 0) {
        console.log(`進度 ${processed}/${todo.length}（寫 ${written}, 缺 ${missing}, 錯 ${errors}）`);
      }
    }
  }

  // 並行執行：分批
  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.all(todo.slice(i, i + concurrency).map(processOne));
  }

  console.log('---');
  console.log(`寫入: ${written}, API 沒 ${date}: ${missing}, 錯誤: ${errors}`);
}

main().catch(err => { console.error(err); process.exit(1); });
