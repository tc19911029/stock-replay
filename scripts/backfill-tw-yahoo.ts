/**
 * Yahoo Finance backfill for TW .TWO 上櫃股
 *
 * MultiMarketProvider 對 .TWO 上櫃股的 fallback chain（FinMind → EODHD → TWSE → Yahoo）
 * 在 5/12 backfill 場景下實測 5/5 拿不到（FinMind 400 + 後續 vendor 多有 stale）。
 * Yahoo Chart API 可直接拉 .TWO 歷史，這支腳本繞過 chain 直打 Yahoo。
 *
 * 用法：
 *   npx tsx scripts/backfill-tw-yahoo.ts --date 2026-05-12
 *   npx tsx scripts/backfill-tw-yahoo.ts --date 2026-05-12 --suffix TWO --concurrency 8
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { fetchJsonWithCurlFallback } from '../lib/datasource/curlFetch';

interface Args { date: string; suffix?: 'TW' | 'TWO'; dry: boolean; limit: number; concurrency: number; }
function parseArgs(): Args {
  const a: Args = { date: '', dry: false, limit: Infinity, concurrency: 8 };
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

async function fetchYahoo(symbol: string, date: string): Promise<{ open: number; high: number; low: number; close: number; volume: number } | null> {
  const target = new Date(date);
  const p1 = Math.floor(new Date(target.getFullYear(), target.getMonth() - 1, target.getDate()).getTime() / 1000);
  const p2 = Math.floor(new Date(target.getFullYear(), target.getMonth(), target.getDate() + 1).getTime() / 1000);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${p1}&period2=${p2}&interval=1d`;
  // Yahoo 對 Node fetch 403（TLS fingerprint），改走 curl fallback
  const { data: json } = await fetchJsonWithCurlFallback<{ chart: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }> } }>; error?: unknown } }>(url, { timeoutMs: 10_000 });
  const r = json.chart.result?.[0];
  if (!r) return null;
  const ts = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0];
  if (!q) return null;
  for (let i = 0; i < ts.length; i++) {
    const d = new Date(ts[i] * 1000).toISOString().split('T')[0];
    if (d === date) {
      const open = q.open[i], high = q.high[i], low = q.low[i], close = q.close[i], volume = q.volume[i];
      if (open == null || close == null) return null;
      return {
        open: Number(open.toFixed(2)),
        high: Number((high ?? close).toFixed(2)),
        low: Number((low ?? close).toFixed(2)),
        close: Number(close.toFixed(2)),
        volume: Math.round((volume ?? 0) / 1000), // 股 → 張
      };
    }
  }
  return null;
}

async function main() {
  const { date, suffix, dry, limit, concurrency } = parseArgs();
  console.log(`Yahoo backfill: ${date} suffix=${suffix ?? '*'} ${dry ? '(DRY)' : ''} concurrency=${concurrency}`);

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
      const ohlcv = await fetchYahoo(sym, date);
      if (!ohlcv || ohlcv.close <= 0) { missing++; return; }
      if (!dry) await saveLocalCandles(sym, 'TW', [{ date, ...ohlcv }]);
      written++;
      if (written <= 5 || written % 100 === 0) {
        console.log(`  ${written}: ${sym} ${date} O=${ohlcv.open} H=${ohlcv.high} L=${ohlcv.low} C=${ohlcv.close} V=${ohlcv.volume}`);
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
    await new Promise(r => setTimeout(r, 80)); // 友善 rate
  }

  console.log('---');
  console.log(`寫入: ${written}, Yahoo 沒 ${date}: ${missing}, 錯誤: ${errors}`);
}

main().catch(err => { console.error(err); process.exit(1); });
