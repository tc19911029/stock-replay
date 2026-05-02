/**
 * audit-repair-blob-ohlc.ts
 *
 * 稽核並修復 Vercel Blob 生產資料中的 OHLC 矛盾。
 * 需要 BLOB_READ_WRITE_TOKEN 環境變數。
 *
 * 用法：
 *   npx tsx scripts/audit-repair-blob-ohlc.ts
 *   npx tsx scripts/audit-repair-blob-ohlc.ts --market TW
 *   npx tsx scripts/audit-repair-blob-ohlc.ts --market CN
 *   npx tsx scripts/audit-repair-blob-ohlc.ts --dry-run
 *   npx tsx scripts/audit-repair-blob-ohlc.ts --days 60   # 檢查最近 N 天
 */

import 'dotenv/config';
import { list, put, get } from '@vercel/blob';

const DRY_RUN = process.argv.includes('--dry-run');
const MARKET_ARG = process.argv.find(a => a.startsWith('--market='))?.replace('--market=', '')
  ?? process.argv[process.argv.indexOf('--market') + 1];
const DAYS_ARG = parseInt(process.argv.find(a => a.startsWith('--days='))?.replace('--days=', '') ?? '45', 10);

const MARKETS: Array<'TW' | 'CN'> = MARKET_ARG === 'TW' ? ['TW'] : MARKET_ARG === 'CN' ? ['CN'] : ['TW', 'CN'];

interface RawCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandleFile {
  symbol: string;
  lastDate: string;
  updatedAt: string;
  candles: RawCandle[];
  sealedDate?: string;
}

// 計算 N 天前的日期字串
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function hasOHLCViolation(c: RawCandle): boolean {
  return c.high < c.close || c.low > c.close || c.high < c.open || c.low > c.open;
}

async function fetchYahooEOD(ticker: string, dates: string[], market: 'TW' | 'CN'): Promise<Map<string, RawCandle>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=30d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as {
    chart: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }> } }> };
  };
  const result = json.chart.result?.[0];
  if (!result) throw new Error('No chart data');

  const map = new Map<string, RawCandle>();
  const { timestamp, indicators } = result;
  const q = indicators.quote[0];
  const precision = market === 'CN' ? 3 : 2;
  const volDivisor = market === 'TW' ? 1000 : 100; // TW: 股→張, CN: 股→手

  for (let i = 0; i < timestamp.length; i++) {
    const date = new Date(timestamp[i] * 1000).toISOString().split('T')[0];
    if (!dates.includes(date)) continue;
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (!o || !h || !l || !c) continue;
    map.set(date, {
      date,
      open: +o.toFixed(precision),
      high: +h.toFixed(precision),
      low: +l.toFixed(precision),
      close: +c.toFixed(precision),
      volume: Math.round(v / volDivisor),
    });
  }
  return map;
}

async function listBlobKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await list({ prefix, cursor, limit: 1000 });
    for (const blob of result.blobs) {
      keys.push(blob.pathname);
    }
    cursor = result.cursor;
  } while (cursor);
  return keys;
}

async function readBlob(pathname: string): Promise<string | null> {
  try {
    const result = await get(pathname, { access: 'private' });
    if (!result?.stream) return null;
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

async function writeBlob(pathname: string, content: string): Promise<void> {
  await put(pathname, content, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
}

async function auditMarket(market: 'TW' | 'CN', cutoffDate: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`稽核 ${market} Blob candles (>= ${cutoffDate})`);
  console.log('='.repeat(60));

  const prefix = `candles/${market}/`;
  console.log(`列出 Blob 檔案: ${prefix}...`);
  const keys = await listBlobKeys(prefix);
  console.log(`共 ${keys.length} 個檔案`);

  let checked = 0;
  const violations: Array<{ key: string; symbol: string; badBars: Array<{ date: string; bar: RawCandle }> }> = [];

  // 分批讀取，避免太多並發
  const BATCH = 50;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (key) => {
        const raw = await readBlob(key);
        if (!raw) return null;
        const data: CandleFile = JSON.parse(raw);
        const candles: RawCandle[] = data.candles ?? [];
        const badBars = candles
          .filter(c => c.date >= cutoffDate && hasOHLCViolation(c))
          .map(c => ({ date: c.date, bar: c }));
        if (badBars.length > 0) {
          return { key, symbol: data.symbol ?? key.split('/').pop()!.replace('.json', ''), badBars };
        }
        return null;
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        violations.push(r.value);
      }
    }
    checked += batch.length;
    if (checked % 200 === 0 || checked === keys.length) {
      process.stdout.write(`  檢查中... ${checked}/${keys.length}\r`);
    }
  }
  process.stdout.write('\n');

  if (violations.length === 0) {
    console.log(`✅ ${market}: 無 OHLC 矛盾`);
    return;
  }

  // 彙整 violation 的日期
  const dateToViolations = new Map<string, typeof violations>();
  for (const v of violations) {
    for (const b of v.badBars) {
      if (!dateToViolations.has(b.date)) dateToViolations.set(b.date, []);
      dateToViolations.get(b.date)!.push(v);
    }
  }

  console.log(`\n⚠️  ${market} 發現 ${violations.length} 支股票有 OHLC 矛盾：`);
  for (const [date, vs] of [...dateToViolations.entries()].sort()) {
    console.log(`  ${date}: ${vs.length} 支`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] 不寫入，僅列出');
    for (const v of violations.slice(0, 20)) {
      for (const b of v.badBars) {
        console.log(`  ${v.symbol} ${b.date}: o=${b.bar.open} h=${b.bar.high} l=${b.bar.low} c=${b.bar.close}`);
      }
    }
    return;
  }

  // 修復
  console.log('\n開始修復...');
  let fixed = 0, failed = 0;

  for (const v of violations) {
    const { key, symbol } = v;
    const dates = v.badBars.map(b => b.date);
    const ticker = market === 'TW' ? symbol : symbol.replace('.SS', '').replace('.SZ', '') + (symbol.includes('.SS') ? '.SS' : '.SZ');
    const yahooTicker = ticker.includes('.') ? ticker : `${ticker}.${market === 'CN' ? 'SZ' : 'TW'}`;

    try {
      const yahoo = await fetchYahooEOD(yahooTicker, dates, market);
      if (yahoo.size === 0) {
        // TW: 嘗試 .TWO
        if (market === 'TW') {
          const altTicker = symbol.endsWith('.TW') ? symbol.replace('.TW', '.TWO') : symbol.replace('.TWO', '.TW');
          const yahoo2 = await fetchYahooEOD(altTicker, dates, market);
          if (yahoo2.size === 0) {
            console.log(`  SKIP ${symbol}: Yahoo 無資料`);
            failed++;
            continue;
          }
          yahoo2.forEach((v, k) => yahoo.set(k, v));
        } else {
          // CN: 嘗試 .SS
          const altTicker = symbol.includes('.SZ') ? symbol.replace('.SZ', '.SS') : symbol.replace('.SS', '.SZ');
          const yahoo2 = await fetchYahooEOD(altTicker, dates, market);
          if (yahoo2.size === 0) {
            console.log(`  SKIP ${symbol}: Yahoo 無資料`);
            failed++;
            continue;
          }
          yahoo2.forEach((vv, k) => yahoo.set(k, vv));
        }
      }

      const raw = await readBlob(key);
      if (!raw) { failed++; continue; }
      const data: CandleFile = JSON.parse(raw);
      let fileFixed = 0;
      for (let i = 0; i < data.candles.length; i++) {
        const c = data.candles[i];
        if (!dates.includes(c.date)) continue;
        const correct = yahoo.get(c.date);
        if (!correct) {
          console.log(`  MISS ${symbol} ${c.date}: Yahoo 無此日期`);
          continue;
        }
        console.log(`  FIX ${symbol} ${c.date}: o=${c.open}→${correct.open} h=${c.high}→${correct.high} l=${c.low}→${correct.low} c=${c.close}→${correct.close}`);
        data.candles[i] = correct;
        fileFixed++;
      }
      if (fileFixed > 0) {
        data.updatedAt = new Date().toISOString();
        await writeBlob(key, JSON.stringify(data));
      }
      fixed++;
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      console.log(`  ERROR ${symbol}: ${(e as Error).message}`);
      failed++;
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`\n${market} 完成：修復 ${fixed} 支，失敗 ${failed} 支`);
}

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('❌ BLOB_READ_WRITE_TOKEN 未設定');
    process.exit(1);
  }

  const cutoffDate = daysAgo(DAYS_ARG);
  console.log(`\n=== Vercel Blob OHLC 稽核 ${DRY_RUN ? '[DRY RUN]' : ''} ===`);
  console.log(`檢查日期範圍: ${cutoffDate} ~ 今天，Markets: ${MARKETS.join(', ')}`);

  for (const market of MARKETS) {
    await auditMarket(market, cutoffDate);
  }

  console.log('\n✅ 全部完成');
}

main().catch(console.error);
