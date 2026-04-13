#!/usr/bin/env npx tsx
/**
 * verify-candles.ts — Layer 1 歷史 K 線資料驗證腳本
 *
 * 用 Yahoo Finance 作為參照來源，逐股比對本地 OHLCV 資料。
 * 產出 JSON 報告，供後續 correct-candles.ts 使用。
 *
 * 用法：
 *   npx tsx scripts/verify-candles.ts --market TW
 *   npx tsx scripts/verify-candles.ts --market CN --concurrency 3
 *   npx tsx scripts/verify-candles.ts --market TW --sample 20 --resume
 */

import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import {
  compareCandles,
  defaultConfig,
  type ComparisonResult,
  type VerificationReport,
} from '../lib/datasource/CandleVerifier';
import type { Candle } from '../types';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const MARKET = getArg('market', 'TW') as 'TW' | 'CN';
const CONCURRENCY = parseInt(getArg('concurrency', '5'), 10);
const SAMPLE = hasFlag('sample') ? parseInt(getArg('sample', '10'), 10) : 0;
const RESUME = hasFlag('resume');
const DATE_START = getArg('from', '2024-04-13');
const DATE_END = getArg('to', '2026-04-13');

const DATA_DIR = path.join(process.cwd(), 'data', 'candles', MARKET);
const CHECKPOINT_PATH = path.join(process.cwd(), 'data', `verify-checkpoint-${MARKET}.json`);

// ── Yahoo Finance fetch (raw OHLC, no adjustment) ────────────────────────────

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
};

function parseYahooCandlesRaw(json: unknown): Candle[] {
  const result = (json as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as {
    timestamp?: number[];
    indicators?: {
      quote?: { open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }[];
    };
  } | undefined;
  if (!result) return [];

  const timestamps: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!q) return [];

  return timestamps
    .map((ts, i) => {
      const o = q.open[i]; const h = q.high[i];
      const l = q.low[i];  const c = q.close[i];
      const v = q.volume[i];
      if (o == null || h == null || l == null || c == null || isNaN(o)) return null;
      return {
        date:   new Date(ts * 1000).toISOString().split('T')[0],
        open:   +o.toFixed(2),
        high:   +h.toFixed(2),
        low:    +l.toFixed(2),
        close:  +c.toFixed(2),
        volume: v ?? 0,
      };
    })
    .filter((c): c is Candle => c != null);
}

async function fetchYahooCandles(symbol: string, startDate: string, endDate: string): Promise<Candle[]> {
  const startUnix = Math.floor(new Date(startDate).getTime() / 1000);
  const endUnix = Math.floor(new Date(endDate).getTime() / 1000) + 86400;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${startUnix}&period2=${endUnix}&includePrePost=false&events=split`;

  const res = await fetch(url, {
    headers: YF_HEADERS,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Yahoo ${res.status} for ${symbol}`);
  }

  return parseYahooCandlesRaw(await res.json());
}

// ── Checkpoint ───────────────────────────────────────────────────────────────

interface Checkpoint {
  completedSymbols: string[];
  timestamp: string;
}

async function loadCheckpoint(): Promise<Set<string>> {
  if (!RESUME) return new Set();
  try {
    const raw = await readFile(CHECKPOINT_PATH, 'utf-8');
    const cp: Checkpoint = JSON.parse(raw);
    console.log(`📌 Resuming from checkpoint: ${cp.completedSymbols.length} symbols already done (${cp.timestamp})`);
    return new Set(cp.completedSymbols);
  } catch {
    return new Set();
  }
}

async function saveCheckpoint(completed: string[]): Promise<void> {
  const cp: Checkpoint = { completedSymbols: completed, timestamp: new Date().toISOString() };
  await writeFile(CHECKPOINT_PATH, JSON.stringify(cp), 'utf-8');
}

// ── Concurrent batch runner ──────────────────────────────────────────────────

async function runConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🔍 Layer 1 驗證：${MARKET} 市場`);
  console.log(`   日期範圍: ${DATE_START} ~ ${DATE_END}`);
  console.log(`   並發數: ${CONCURRENCY}`);
  if (SAMPLE > 0) console.log(`   抽樣模式: ${SAMPLE} 支`);

  // 1. 列出所有本地 candle 檔案
  const allFiles = (await readdir(DATA_DIR)).filter(f => f.endsWith('.json'));
  console.log(`   本地檔案數: ${allFiles.length}`);

  // 2. 載入 checkpoint
  const completed = await loadCheckpoint();
  const pendingFiles = allFiles.filter(f => !completed.has(f.replace('.json', '')));

  // 3. 抽樣（若指定）
  const targetFiles = SAMPLE > 0 ? pendingFiles.slice(0, SAMPLE) : pendingFiles;
  console.log(`   待驗證: ${targetFiles.length} 支\n`);

  const config = {
    ...defaultConfig(MARKET),
    dateRangeStart: DATE_START,
    dateRangeEnd: DATE_END,
  };

  const issues: ComparisonResult[] = [];
  const failures: Array<{ symbol: string; error: string }> = [];
  let checkedCount = 0;
  let cleanCount = 0;
  const completedSymbols = [...completed];

  const startTime = Date.now();

  // 4. 逐批驗證
  await runConcurrent(targetFiles, CONCURRENCY, async (file, i) => {
    const symbol = file.replace('.json', '');

    try {
      // 讀本地
      const raw = await readFile(path.join(DATA_DIR, file), 'utf-8');
      const data = JSON.parse(raw) as { candles: Candle[] };
      const localCandles = data.candles ?? [];

      if (localCandles.length === 0) {
        failures.push({ symbol, error: 'empty local file' });
        return;
      }

      // 讀 Yahoo 參照
      const refCandles = await fetchYahooCandles(symbol, DATE_START, DATE_END);

      if (refCandles.length === 0) {
        failures.push({ symbol, error: 'Yahoo returned 0 candles (delisted or unavailable)' });
        completedSymbols.push(symbol);
        return;
      }

      // 比對
      const result = compareCandles(symbol, localCandles, refCandles, config);
      checkedCount++;

      if (result.severity === 'clean') {
        cleanCount++;
      } else {
        issues.push(result);
      }

      completedSymbols.push(symbol);

      // 進度顯示（每 50 支）
      const done = i + 1;
      if (done % 50 === 0 || done === targetFiles.length) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const pct = ((done / targetFiles.length) * 100).toFixed(1);
        console.log(`  [${pct}%] ${done}/${targetFiles.length} | clean=${cleanCount} issues=${issues.length} failed=${failures.length} | ${elapsed}s`);

        // 定期存 checkpoint
        await saveCheckpoint(completedSymbols);
      }

      // 簡易限流：每次請求後等一小段
      await sleep(200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ symbol, error: msg.slice(0, 200) });
      completedSymbols.push(symbol);
    }
  });

  // 5. 產出報告
  const report: VerificationReport = {
    market: MARKET,
    dateRange: { from: DATE_START, to: DATE_END },
    generatedAt: new Date().toISOString(),
    summary: {
      totalStocks: allFiles.length,
      stocksChecked: checkedCount,
      stocksWithIssues: issues.length,
      stocksClean: cleanCount,
      stocksFailed: failures.length,
      totalMissingDates: issues.reduce((s, i) => s + i.missingDates.length, 0),
      totalExtraDates: issues.reduce((s, i) => s + i.extraDates.length, 0),
      totalPriceMismatches: issues.reduce((s, i) => s + i.priceMismatches.length, 0),
      totalVolumeMismatches: issues.reduce((s, i) => s + i.volumeMismatches.length, 0),
    },
    issues: issues.sort((a, b) => severityOrder(b.severity) - severityOrder(a.severity)),
    failures,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(process.cwd(), 'data', `verify-report-${MARKET}-${ts}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  // 最終 checkpoint
  await saveCheckpoint(completedSymbols);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 6. 列印摘要
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ ${MARKET} 驗證完成（${elapsed}s）`);
  console.log(`   總檔案: ${report.summary.totalStocks}`);
  console.log(`   已驗證: ${report.summary.stocksChecked}`);
  console.log(`   ✔ 乾淨: ${report.summary.stocksClean}`);
  console.log(`   ⚠ 有問題: ${report.summary.stocksWithIssues}`);
  console.log(`   ✖ 失敗: ${report.summary.stocksFailed}`);
  console.log(`   ---`);
  console.log(`   缺失日期: ${report.summary.totalMissingDates}`);
  console.log(`   多餘日期: ${report.summary.totalExtraDates}`);
  console.log(`   價格不符: ${report.summary.totalPriceMismatches}`);
  console.log(`   量不符: ${report.summary.totalVolumeMismatches}`);
  const totalSplits = issues.reduce((s, i) => s + (i.splitAdjustments?.length ?? 0), 0);
  if (totalSplits > 0) console.log(`   分割調整（已排除）: ${totalSplits} 天`);
  console.log(`\n📄 報告: ${reportPath}`);

  // 列出 top 10 最嚴重的
  if (issues.length > 0) {
    console.log(`\n🔴 Top issues (severity=high/medium):`);
    const top = issues.filter(i => i.severity === 'high' || i.severity === 'medium').slice(0, 10);
    for (const t of top) {
      console.log(`   ${t.symbol}: missing=${t.missingDates.length} price=${t.priceMismatches.length} vol=${t.volumeMismatches.length} [${t.severity}]`);
    }
  }

  if (failures.length > 0) {
    console.log(`\n🟡 Top failures:`);
    for (const f of failures.slice(0, 10)) {
      console.log(`   ${f.symbol}: ${f.error}`);
    }
  }
}

function severityOrder(s: string): number {
  switch (s) {
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
