/**
 * T+1 Fill Gaps — 對昨天 settle 完仍 pending 的個股做補洞
 *
 * 為什麼要 T+1：盤後 settle 跑的時候，有些 vendor 還沒 sync（如 EODHD 對某些 .TWO
 * 上櫃可能延遲）。隔天早上再跑一次補洞 — 這時 vendor 都已有昨日資料。
 *
 * 用法：
 *   npx tsx scripts/t1-fill-gaps.ts --market TW --date 2026-05-12
 *   npx tsx scripts/t1-fill-gaps.ts --market TW --date 2026-05-12 --apply
 *
 * 流程：
 *   1. 讀 data/settle-reports/settle-{market}-{date}.json
 *   2. 對每個 pending 股，重新跑 settleSymbol（vendor 重試）
 *   3. 若仍 pending，輸出剩餘清單給用戶手動處理（或之後接 AI WebFetch）
 */
import { config } from 'dotenv';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { settleSymbol, type Market, type VendorQuote } from '../lib/datasource/eodSettle';
import { prefetchVendorBatch } from '../lib/datasource/eodSettleBatch';

interface Args { market: Market; date: string; apply: boolean; concurrency: number; }
function parseArgs(): Args {
  const a: Args = { market: 'TW', date: '', apply: false, concurrency: 4 };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === '--market') a.market = process.argv[++i] as Market;
    else if (x === '--date') a.date = process.argv[++i];
    else if (x === '--apply') a.apply = true;
    else if (x === '--concurrency') a.concurrency = parseInt(process.argv[++i], 10);
  }
  if (!a.date) { console.error('--date YYYY-MM-DD required'); process.exit(1); }
  return a;
}

interface PendingEntry {
  symbol: string;
  status: string;
  vendors?: string[];
  disagreements?: string[];
}

function readExisting(market: Market, sym: string, date: string): VendorQuote | undefined {
  const f = path.join(process.cwd(), 'data', 'candles', market, `${sym}.json`);
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    const candles = Array.isArray(raw) ? raw : (raw.candles || []);
    const c = candles.find((c: { date: string }) => c.date === date);
    if (!c) return undefined;
    return { vendor: 'L1', open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
  } catch { return undefined; }
}

async function main() {
  const { market, date, apply, concurrency } = parseArgs();
  const reportFile = path.join(process.cwd(), 'data', 'settle-reports', `settle-${market}-${date}.json`);
  if (!existsSync(reportFile)) {
    console.error(`Settle report not found: ${reportFile}`);
    console.error(`先跑 eod-settle: npx tsx scripts/eod-settle.ts --market ${market} --date ${date} --apply`);
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { pending: PendingEntry[] };
  const pending = report.pending ?? [];
  console.log(`T+1 fill: market=${market} date=${date} ${apply ? '★ APPLY' : '(DRY)'} pending=${pending.length}`);

  if (pending.length === 0) {
    console.log('沒有 pending — 無需處理');
    return;
  }

  // 重抓 batch cache（vendor 端可能 sync 了）
  console.log('prefetch vendor batch...');
  const t0 = Date.now();
  const batchCache = await prefetchVendorBatch(market, date);
  console.log(`  done ${Date.now() - t0}ms`);

  const remaining: PendingEntry[] = [];
  const resolvedSettled: Array<{ symbol: string; vendors: string[]; close: number }> = [];
  const resolvedDisagree: Array<{ symbol: string; vendors: string[] }> = [];

  let processed = 0;
  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(async p => {
      const existing = readExisting(market, p.symbol, date);
      const r = await settleSymbol(p.symbol, market, date, existing, batchCache);
      return { p, r };
    }));

    for (const { p, r } of batchResults) {
      if (r.status === 'settled-multi-source' && r.settled) {
        resolvedSettled.push({
          symbol: p.symbol,
          vendors: r.vendors.map(v => `${v.vendor}=${v.close}`),
          close: r.settled.close,
        });
        if (apply) {
          await saveLocalCandles(p.symbol, market, [{
            date,
            open: r.settled.open,
            high: r.settled.high,
            low: r.settled.low,
            close: r.settled.close,
            volume: r.settled.volume,
          }]);
        }
      } else if (r.status === 'settled-single-source') {
        resolvedDisagree.push({
          symbol: p.symbol,
          vendors: r.vendors.map(v => `${v.vendor}=${v.close}`),
        });
      } else {
        remaining.push({
          symbol: p.symbol,
          status: r.status,
          vendors: r.vendors.map(v => `${v.vendor}=${v.close}`),
          disagreements: r.disagreements,
        });
      }
    }
    processed += batch.length;
    if (processed % 20 === 0 || processed >= pending.length) {
      process.stdout.write(`  ${processed}/${pending.length} (resolved=${resolvedSettled.length}, single=${resolvedDisagree.length}, remain=${remaining.length})\n`);
    }
  }

  console.log('---');
  console.log(`Resolved (settled-multi-source, ${apply ? '已寫入' : '可寫入'}): ${resolvedSettled.length}`);
  resolvedSettled.slice(0, 10).forEach(r => console.log(`  ${r.symbol} close=${r.close} (${r.vendors.join(', ')})`));
  console.log(`Single-source 不確定: ${resolvedDisagree.length}`);
  resolvedDisagree.slice(0, 5).forEach(r => console.log(`  ${r.symbol} (${r.vendors.join(', ')})`));
  console.log(`Remain pending: ${remaining.length}`);
  remaining.slice(0, 10).forEach(r => console.log(`  ${r.symbol} ${r.status} (${r.vendors?.join(', ') ?? '無 vendor'})`));

  // 寫剩餘清單到報告
  const t1Report = path.join(process.cwd(), 'data', 'settle-reports', `t1-${market}-${date}.json`);
  mkdirSync(path.dirname(t1Report), { recursive: true });
  writeFileSync(t1Report, JSON.stringify({
    generatedAt: new Date().toISOString(),
    market, date, apply,
    resolvedCount: resolvedSettled.length,
    singleSourceCount: resolvedDisagree.length,
    remainingCount: remaining.length,
    resolved: resolvedSettled,
    singleSource: resolvedDisagree,
    remaining,
  }, null, 2));
  console.log(`報告寫入 ${t1Report}`);

  // 殘留股 → 需要 AI WebFetch 補（這層手動）
  if (remaining.length > 0) {
    console.log('');
    console.log(`★ ${remaining.length} 檔仍 pending — 需要走 AI WebFetch 補（從 stooq / Yahoo 網頁 / 公開財經頁）`);
    console.log(`  symbols: ${remaining.slice(0, 30).map(r => r.symbol).join(', ')}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
