#!/usr/bin/env npx tsx
/**
 * download-l1-yahoo.ts — 用 Yahoo Finance 批量下載 L1 歷史K線
 *
 * Yahoo Finance 無需 API key，速度快，適合批量補資料。
 *
 * 用法：
 *   npx tsx scripts/download-l1-yahoo.ts TW
 *   npx tsx scripts/download-l1-yahoo.ts CN
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

const market = process.argv[2]?.toUpperCase() as 'TW' | 'CN';
if (market !== 'TW' && market !== 'CN') {
  console.error('Usage: npx tsx scripts/download-l1-yahoo.ts TW|CN');
  process.exit(1);
}

const TARGET_DATE = '2026-04-15';
const BATCH = 10;
const DATA_ROOT = path.join(process.cwd(), 'data', 'candles', market);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Accept: 'application/json',
};

interface Candle {
  date: string; open: number; high: number; low: number; close: number; volume: number;
}

function parseYahooCandles(json: unknown): Candle[] {
  const result = (json as any)?.chart?.result?.[0];
  if (!result) return [];
  const timestamps: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!q) return [];
  return timestamps
    .map((ts: number, i: number) => {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
      if (o == null || h == null || l == null || c == null || isNaN(o)) return null;
      return {
        date: new Date(ts * 1000).toISOString().split('T')[0],
        open: +o.toFixed(2), high: +h.toFixed(2),
        low: +l.toFixed(2), close: +c.toFixed(2),
        volume: market === 'TW' ? Math.round((v ?? 0) / 1000) : (v ?? 0), // TW: 股→張
      };
    })
    .filter((c): c is Candle => c != null && c.open > 0);
}

function yahooSymbol(localSymbol: string): string {
  // 1595.TWO.json → 1595.TWO, 2330.TW.json → 2330.TW
  // 601138.SS.json → 601138.SS
  return localSymbol.replace('.json', '');
}

async function fetchYahoo(symbol: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2y&includePrePost=false`;
  const res = await fetch(url, {
    headers: YF_HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${symbol}`);
  return parseYahooCandles(await res.json());
}

async function main() {
  if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });

  // 找出需要更新的檔案
  const files = readdirSync(DATA_ROOT).filter(f => f.endsWith('.json'));
  const needUpdate: string[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(path.join(DATA_ROOT, f), 'utf8'));
      const lastCandle = data.candles?.[data.candles.length - 1]?.date;
      if (!lastCandle || lastCandle < TARGET_DATE) {
        needUpdate.push(f);
      }
    } catch {
      needUpdate.push(f);
    }
  }

  console.log(`[${market}] 總共 ${files.length} 支，需更新 ${needUpdate.length} 支（目標: ${TARGET_DATE}）`);
  if (needUpdate.length === 0) { console.log('已是最新！'); return; }

  let ok = 0, fail = 0;
  const failedSymbols: string[] = [];
  const start = Date.now();

  for (let i = 0; i < needUpdate.length; i += BATCH) {
    const batch = needUpdate.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (filename) => {
        const symbol = yahooSymbol(filename);
        const candles = await fetchYahoo(symbol);
        if (candles.length < 30) throw new Error(`太少: ${candles.length} 根`);

        // 寫入本地
        const lastDate = candles[candles.length - 1].date;
        const data = {
          symbol,
          lastDate,
          updatedAt: new Date().toISOString(),
          candles,
          sealedDate: lastDate,
        };
        writeFileSync(path.join(DATA_ROOT, filename), JSON.stringify(data), 'utf8');
        return lastDate;
      }),
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        ok++;
      } else {
        fail++;
        failedSymbols.push(batch[j]);
        // 只在前幾個列印錯誤
        if (fail <= 10) console.error(`  ❌ ${batch[j]}: ${(r.reason as Error)?.message?.slice(0, 60)}`);
      }
    }

    const done = i + batch.length;
    if (done % 100 === 0 || done === needUpdate.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`  [${done}/${needUpdate.length}] ok=${ok} fail=${fail} | ${elapsed}s`);
    }

    if (i + BATCH < needUpdate.length) await sleep(500);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✅ ${market} 完成: ${ok} 成功, ${fail} 失敗, ${elapsed}s`);
  if (failedSymbols.length > 0 && failedSymbols.length <= 50) {
    console.log(`失敗清單: ${failedSymbols.join(', ')}`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
