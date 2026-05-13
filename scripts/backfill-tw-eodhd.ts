/**
 * EODHD backfill for TW (.TW / .TWO) L1 指定日期
 *
 * Yahoo backfill 受 rate limit 卡 429 不可用時的替代來源。
 * EODHD 有 token、對 .TWO 拉得到 5/12 收盤資料。
 *
 * 用法：
 *   npx tsx scripts/backfill-tw-eodhd.ts --date 2026-05-12 --suffix TWO --concurrency 6
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';

interface Args { date: string; suffix?: 'TW' | 'TWO'; dry: boolean; limit: number; concurrency: number; }
function parseArgs(): Args {
  const a: Args = { date: '', dry: false, limit: Infinity, concurrency: 6 };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === '--date') a.date = process.argv[++i];
    else if (x === '--suffix') a.suffix = process.argv[++i] as 'TW' | 'TWO';
    else if (x === '--dry') a.dry = true;
    else if (x === '--limit') a.limit = parseInt(process.argv[++i], 10);
    else if (x === '--concurrency') a.concurrency = parseInt(process.argv[++i], 10);
  }
  if (!a.date) { console.error('--date required'); process.exit(1); }
  return a;
}

interface EodhdRow { date: string; open: number; high: number; low: number; close: number; volume: number; }

async function fetchEodhd(symbol: string, date: string, token: string): Promise<EodhdRow | null> {
  // 取 date 前後各 3 天，避免單日 endpoint 在假日空回
  const target = new Date(date);
  const from = new Date(target); from.setDate(from.getDate() - 3);
  const to = new Date(target); to.setDate(to.getDate() + 1);
  const fromStr = from.toISOString().split('T')[0];
  const toStr = to.toISOString().split('T')[0];
  const url = `https://eodhd.com/api/eod/${symbol}?api_token=${token}&from=${fromStr}&to=${toStr}&fmt=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`EODHD ${res.status}`);
  const rows = await res.json() as EodhdRow[];
  if (!Array.isArray(rows)) return null;
  return rows.find(r => r.date === date) ?? null;
}

async function main() {
  const { date, suffix, dry, limit, concurrency } = parseArgs();
  const token = process.env.EODHD_API_TOKEN;
  if (!token) { console.error('EODHD_API_TOKEN not set'); process.exit(1); }
  console.log(`EODHD backfill: ${date} suffix=${suffix ?? '*'} ${dry ? '(DRY)' : ''} concurrency=${concurrency}`);

  const candleDir = path.join(process.cwd(), 'data', 'candles', 'TW');
  const todo: string[] = [];
  for (const f of readdirSync(candleDir)) {
    if (!f.endsWith('.json')) continue;
    if (suffix && !f.endsWith(`.${suffix}.json`)) continue;
    const sym = f.replace('.json', '');
    try {
      const raw = JSON.parse(readFileSync(path.join(candleDir, f), 'utf8'));
      const candles = Array.isArray(raw) ? raw : (raw.candles || []);
      if (candles.length === 0) continue;
      const lastDate = candles[candles.length - 1].date;
      if (lastDate < date) todo.push(sym);
    } catch { continue; }
    if (todo.length >= limit) break;
  }
  console.log(`待補 ${todo.length} 檔`);

  let written = 0, missing = 0, errors = 0, processed = 0;

  async function processOne(sym: string) {
    try {
      const row = await fetchEodhd(sym, date, token!);
      if (!row || row.close <= 0) { missing++; return; }
      if (!dry) {
        await saveLocalCandles(sym, 'TW', [{
          date,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: Math.round(row.volume / 1000), // 股 → 張
        }]);
      }
      written++;
      if (written <= 5 || written % 100 === 0) {
        console.log(`  ${written}: ${sym} ${date} O=${row.open} H=${row.high} L=${row.low} C=${row.close} V=${Math.round(row.volume / 1000)}`);
      }
    } catch (err) {
      errors++;
      if (errors <= 3) console.warn(`  ${sym}: ${err instanceof Error ? err.message : err}`);
    } finally {
      processed++;
      if (processed % 100 === 0) {
        console.log(`進度 ${processed}/${todo.length} (寫 ${written}, 缺 ${missing}, 錯 ${errors})`);
      }
    }
  }

  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.all(todo.slice(i, i + concurrency).map(processOne));
  }

  console.log('---');
  console.log(`寫入: ${written}, EODHD 沒 ${date}: ${missing}, 錯誤: ${errors}`);
}

main().catch(err => { console.error(err); process.exit(1); });
