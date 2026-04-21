#!/usr/bin/env npx tsx
/**
 * verify-l1-l2-accuracy.ts — 隨機抽樣驗證 L1/L2 數據正確性
 *
 * 對比來源：Yahoo Finance（獨立第三方）
 * 驗證項目：
 *   1. L1 K棒收盤價 vs Yahoo 收盤價（每個交易日，誤差 < 2%）
 *   2. L2 快照收盤價 vs Yahoo 收盤價（誤差 < 2%）
 *   3. L1 最後日期是否在容差範圍內
 *
 * 用法：
 *   npx tsx scripts/verify-l1-l2-accuracy.ts --market TW --sample 200
 *   npx tsx scripts/verify-l1-l2-accuracy.ts --market CN --sample 200
 *   npx tsx scripts/verify-l1-l2-accuracy.ts --market TW --sample 100 --days 5
 */

import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const market = (args.find((_, i) => args[i - 1] === '--market') || 'TW').toUpperCase() as 'TW' | 'CN';
const sampleSize = parseInt(args.find((_, i) => args[i - 1] === '--sample') || '200', 10);
const checkDays = parseInt(args.find((_, i) => args[i - 1] === '--days') || '5', 10);

const DATA_ROOT = path.join(process.cwd(), 'data', 'candles', market);
const BATCH = 10;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Accept: 'application/json',
};

interface DayResult {
  date: string;
  l1Close: number;
  yahooClose: number;
  diff: number;
  status: 'ok' | 'mismatch' | 'l1_missing';
}

interface VerifyResult {
  symbol: string;
  l1LastDate: string;
  l2Close: number | null;
  l2Diff: number | null;
  days: DayResult[];
  overallStatus: 'ok' | 'mismatch' | 'yahoo_missing' | 'l1_stale';
}

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function fetchYahooHistory(symbol: string): Promise<Map<string, number>> {
  try {
    const rangeStr = checkDays <= 5 ? '10d' : '20d';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${rangeStr}&includePrePost=false`;
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return new Map();
    const json = await res.json() as any;
    const result = json?.chart?.result?.[0];
    if (!result) return new Map();
    const ts: number[] = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const map = new Map<string, number>();
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] != null) {
        const date = new Date(ts[i] * 1000).toISOString().split('T')[0];
        map.set(date, +closes[i].toFixed(2));
      }
    }
    return map;
  } catch { return new Map(); }
}

function getRecentL1Dates(candles: Array<{ date: string; close: number }>, n: number): Map<string, number> {
  const sorted = [...candles].sort((a, b) => b.date.localeCompare(a.date));
  const map = new Map<string, number>();
  for (const c of sorted.slice(0, n)) {
    map.set(c.date, c.close);
  }
  return map;
}

async function main() {
  // Load latest L2 snapshot
  let l2Map = new Map<string, number>();
  try {
    const snapFiles = readdirSync(path.join(process.cwd(), 'data'))
      .filter(f => f.startsWith(`intraday-${market}-`) && f.endsWith('.json'))
      .sort().reverse();
    if (snapFiles.length > 0) {
      const snap = JSON.parse(readFileSync(path.join(process.cwd(), 'data', snapFiles[0]), 'utf8'));
      const latestSnapDate: string = snapFiles[0].match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
      for (const q of snap.quotes ?? []) {
        if (q.close > 0) l2Map.set(q.symbol, q.close);
      }
      console.log(`L2 快照載入: ${l2Map.size} 支 (${latestSnapDate})`);
    }
  } catch { console.log('L2 快照未找到'); }

  // Random sample L1 files
  const files = shuffleArray(readdirSync(DATA_ROOT).filter(f => f.endsWith('.json'))).slice(0, sampleSize);
  console.log(`\n[${market}] 隨機抽 ${files.length} 支 × 最近 ${checkDays} 個交易日（對比 Yahoo Finance）\n`);

  const results: VerifyResult[] = [];
  let yahooMissing = 0;

  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async (filename) => {
        const filePath = path.join(DATA_ROOT, filename);
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        const symbol = filename.replace('.json', '');
        const candles: Array<{ date: string; close: number }> = data.candles ?? [];
        const l1LastDate = candles[candles.length - 1]?.date ?? '';

        // L1 recent days
        const l1Recent = getRecentL1Dates(candles, checkDays + 3);

        // L2 close (strip suffix for lookup)
        const pureCode = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
        const l2Close = l2Map.get(pureCode) ?? null;

        // Yahoo history
        const yahooHistory = await fetchYahooHistory(symbol);
        if (yahooHistory.size === 0) {
          return {
            symbol, l1LastDate, l2Close, l2Diff: null, days: [],
            overallStatus: 'yahoo_missing' as const,
          };
        }

        // Match Yahoo dates to L1
        const yahooDates = [...yahooHistory.keys()].sort().reverse().slice(0, checkDays);
        const dayResults: DayResult[] = [];
        for (const date of yahooDates) {
          const yahooClose = yahooHistory.get(date)!;
          const l1Close = l1Recent.get(date);
          if (l1Close == null) {
            dayResults.push({ date, l1Close: 0, yahooClose, diff: 0, status: 'l1_missing' });
          } else {
            const diff = Math.abs(l1Close - yahooClose) / yahooClose * 100;
            dayResults.push({ date, l1Close, yahooClose, diff: +diff.toFixed(2), status: diff > 2 ? 'mismatch' : 'ok' });
          }
        }

        // L2 diff: compare vs the latest Yahoo date
        const latestYahooClose = yahooHistory.get(yahooDates[0]);
        const l2Diff = l2Close != null && latestYahooClose != null && latestYahooClose > 0
          ? +( Math.abs(l2Close - latestYahooClose) / latestYahooClose * 100 ).toFixed(2)
          : null;

        const hasMismatch = dayResults.some(d => d.status === 'mismatch');
        const stale = l1LastDate < (yahooDates[yahooDates.length - 1] ?? '');
        const overallStatus = stale ? 'l1_stale' as const : hasMismatch ? 'mismatch' as const : 'ok' as const;

        return { symbol, l1LastDate, l2Close, l2Diff, days: dayResults, overallStatus };
      }),
    );

    for (const r of settled) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
        if (r.value.overallStatus === 'yahoo_missing') yahooMissing++;
      }
    }

    const done = i + batch.length;
    if (done % 50 === 0 || done === files.length) {
      console.log(`  [${done}/${files.length}] 已驗證`);
    }

    if (i + BATCH < files.length) await sleep(500);
  }

  // Summary
  const verified = results.filter(r => r.overallStatus !== 'yahoo_missing');
  const okCount = verified.filter(r => r.overallStatus === 'ok').length;
  const mismatch = verified.filter(r => r.overallStatus === 'mismatch');
  const stale = verified.filter(r => r.overallStatus === 'l1_stale');

  // Per-day accuracy
  const allDayResults = results.flatMap(r => r.days);
  const byDate = new Map<string, { ok: number; mismatch: number; missing: number }>();
  for (const d of allDayResults) {
    const entry = byDate.get(d.date) ?? { ok: 0, mismatch: 0, missing: 0 };
    if (d.status === 'ok') entry.ok++;
    else if (d.status === 'mismatch') entry.mismatch++;
    else entry.missing++;
    byDate.set(d.date, entry);
  }

  console.log(`\n${'='.repeat(65)}`);
  console.log(`[${market}] 驗證結果（最近 ${checkDays} 個交易日）`);
  console.log(`${'='.repeat(65)}`);
  console.log(`  抽樣: ${results.length} 支 / Yahoo有數據: ${verified.length} 支`);
  console.log(`  整體正確 (所有日期誤差<2%): ${okCount}/${verified.length} (${(okCount / Math.max(verified.length, 1) * 100).toFixed(1)}%)`);
  console.log(`  有誤差 (>2%): ${mismatch.length} 支`);
  console.log(`  日期落後: ${stale.length} 支`);
  console.log(`  Yahoo無數據: ${yahooMissing} 支`);

  console.log(`\n  每日正確率:`);
  for (const [date, s] of [...byDate.entries()].sort()) {
    const total = s.ok + s.mismatch + s.missing;
    const pct = total > 0 ? (s.ok / total * 100).toFixed(1) : '-';
    console.log(`    ${date}  ✅${s.ok}  ❌${s.mismatch}  缺${s.missing}  (${pct}%)`);
  }

  // L2 accuracy
  const l2Verified = verified.filter(r => r.l2Diff != null);
  const l2Ok = l2Verified.filter(r => r.l2Diff! < 2);
  if (l2Verified.length > 0) {
    console.log(`\n  L2正確 (誤差<2%): ${l2Ok.length}/${l2Verified.length} (${(l2Ok.length / l2Verified.length * 100).toFixed(1)}%)`);
  }

  // Show mismatches
  if (mismatch.length > 0) {
    console.log(`\n❌ 不匹配清單 (前15):`);
    for (const r of mismatch.slice(0, 15)) {
      const bad = r.days.filter(d => d.status === 'mismatch');
      const summary = bad.map(d => `${d.date}(${d.diff.toFixed(1)}%)`).join(', ');
      console.log(`  ${r.symbol}: ${summary}`);
    }
  }

  // Average diff for matched days
  const goodDays = allDayResults.filter(d => d.status === 'ok');
  if (goodDays.length > 0) {
    const avgDiff = goodDays.reduce((s, d) => s + d.diff, 0) / goodDays.length;
    console.log(`\n  正確日期平均誤差: ${avgDiff.toFixed(3)}%`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
