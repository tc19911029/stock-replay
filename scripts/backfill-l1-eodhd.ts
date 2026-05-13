/**
 * EODHD backfill — 補 TW / CN L1 指定日期
 *
 * EODHD 是這次 5/12 backfill 救援的最穩 vendor（Yahoo 並行 >2 卡 429、FinMind
 * token 過期、TPEx OpenAPI 只回最新日）。
 *
 * Ticker 對應：
 *   TW: 1240.TWO → EODHD 直接用 1240.TWO（含 .TW）
 *   CN: 600519.SS → EODHD 用 600519.SHG（上海）
 *       000001.SZ → EODHD 用 000001.SHE（深圳）
 *
 * 用法：
 *   npx tsx scripts/backfill-l1-eodhd.ts --market TW --date 2026-05-12
 *   npx tsx scripts/backfill-l1-eodhd.ts --market CN --date 2026-05-12
 *   npx tsx scripts/backfill-l1-eodhd.ts --market CN --date 2026-05-12 --concurrency 8 --dry
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';

type Market = 'TW' | 'CN';

interface Args { market: Market; date: string; dry: boolean; limit: number; concurrency: number; }
function parseArgs(): Args {
  const a: Args = { market: 'TW', date: '', dry: false, limit: Infinity, concurrency: 8 };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === '--market') a.market = process.argv[++i] as Market;
    else if (x === '--date') a.date = process.argv[++i];
    else if (x === '--dry') a.dry = true;
    else if (x === '--limit') a.limit = parseInt(process.argv[++i], 10);
    else if (x === '--concurrency') a.concurrency = parseInt(process.argv[++i], 10);
  }
  if (!a.date) { console.error('--date YYYY-MM-DD required'); process.exit(1); }
  if (a.market !== 'TW' && a.market !== 'CN') { console.error('--market TW|CN'); process.exit(1); }
  return a;
}

/** 把 L1 symbol（如 600519.SS / 000001.SZ）轉成 EODHD 用的 ticker */
function toEodhdSymbol(sym: string, market: Market): string {
  if (market === 'TW') return sym; // 1240.TWO / 3044.TW 直接用
  if (sym.endsWith('.SS')) return sym.replace('.SS', '.SHG');
  if (sym.endsWith('.SZ')) return sym.replace('.SZ', '.SHE');
  return sym;
}

interface EodhdRow { date: string; open: number; high: number; low: number; close: number; volume: number; }

async function fetchEodhd(symbol: string, market: Market, date: string, token: string): Promise<EodhdRow | null> {
  const ticker = toEodhdSymbol(symbol, market);
  // 抓 date 前後幾天，避開單日端點假日空回
  const target = new Date(date);
  const from = new Date(target); from.setDate(from.getDate() - 3);
  const to = new Date(target); to.setDate(to.getDate() + 1);
  const fromStr = from.toISOString().split('T')[0];
  const toStr = to.toISOString().split('T')[0];
  const url = `https://eodhd.com/api/eod/${ticker}?api_token=${token}&from=${fromStr}&to=${toStr}&fmt=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`EODHD ${res.status}`);
  const rows = await res.json() as EodhdRow[];
  if (!Array.isArray(rows)) return null;
  return rows.find(r => r.date === date) ?? null;
}

async function main() {
  const { market, date, dry, limit, concurrency } = parseArgs();
  const token = process.env.EODHD_API_TOKEN;
  if (!token) { console.error('EODHD_API_TOKEN not set'); process.exit(1); }
  console.log(`EODHD backfill: market=${market} date=${date} ${dry ? '(DRY)' : ''} concurrency=${concurrency}`);

  const candleDir = path.join(process.cwd(), 'data', 'candles', market);
  if (!existsSync(candleDir)) { console.error(`${candleDir} not exist`); process.exit(1); }

  const todo: string[] = [];
  for (const f of readdirSync(candleDir)) {
    if (!f.endsWith('.json')) continue;
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
      const row = await fetchEodhd(sym, market, date, token!);
      if (!row || row.close <= 0) { missing++; return; }
      // 單位換算：
      //   TW: EODHD 回傳是「股」，L1 用「張」(volume / 1000)
      //   CN: EODHD 回傳是「股」，L1 也用「股」（與 L2 / Tencent / EastMoney 對齊）
      const volume = market === 'TW' ? Math.round(row.volume / 1000) : row.volume;
      if (!dry) {
        await saveLocalCandles(sym, market, [{
          date,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume,
        }]);
      }
      written++;
      if (written <= 5 || written % 100 === 0) {
        console.log(`  ${written}: ${sym} ${date} O=${row.open} H=${row.high} L=${row.low} C=${row.close} V=${volume}`);
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
