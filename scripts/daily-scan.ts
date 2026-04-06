/**
 * 每日掃描腳本 — 下載最新 candle + 執行掃描 + 存檔
 *
 * 用途：收盤後自動執行，產生 4 種變體掃描記錄
 * 支援市場：TW（台股）、CN（陸股）
 *
 * 用法：
 *   npx tsx scripts/daily-scan.ts --market TW       # 只掃台股
 *   npx tsx scripts/daily-scan.ts --market CN       # 只掃陸股
 *   npx tsx scripts/daily-scan.ts --market TW --market CN  # 兩個都掃
 *   npx tsx scripts/daily-scan.ts                   # 預設兩個都掃
 */

// Load env vars
import { config } from 'dotenv';
import { existsSync, readdirSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { ScanSession } from '../lib/scanner/types';
import { saveScanSession } from '../lib/storage/scanStorage';
import { saveLocalCandles, batchCheckFreshness, getLocalCandleDir } from '../lib/datasource/LocalCandleStore';
import { ZHU_V1 } from '../lib/strategy/StrategyConfig';
import { isWeekday } from '../lib/utils/tradingDay';

const CONCURRENCY = 8;
const BATCH_DELAY_MS = 300;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function getTodayDate(market: 'TW' | 'CN'): string {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  return new Date().toLocaleString('sv-SE', { timeZone: tz }).split(' ')[0];
}

// ── Step 1: Download candles ────────────────────────────────────────────

async function downloadCandles(market: 'TW' | 'CN') {
  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
  const lastTradingDate = getTodayDate(market);

  console.log(`\n📥 [${market}] 下載最新 candle 資料...`);
  const stocks = await scanner.getStockList();

  // 增量模式：只下載過時的
  const symbols = stocks.map(s => s.symbol);
  const { fresh, stale, missing } = await batchCheckFreshness(symbols, market, lastTradingDate, 3);
  const skipSet = new Set([...fresh, ...stale]);
  const toDownload = stocks.filter(s => !skipSet.has(s.symbol));

  console.log(`   共 ${stocks.length} 支，已有最新 ${fresh.length + stale.length} 支，需下載 ${toDownload.length} 支`);

  if (toDownload.length === 0) {
    console.log(`   ✅ candle 資料已是最新`);
    return;
  }

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < toDownload.length; i += CONCURRENCY) {
    const batch = toDownload.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ({ symbol }) => {
        const candles = await scanner.fetchCandles(symbol);
        if (candles.length > 0) {
          await saveLocalCandles(symbol, market, candles);
        }
        return candles.length;
      })
    );

    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value > 0) succeeded++;
      else failed++;
    }

    if (i + CONCURRENCY < toDownload.length) await sleep(BATCH_DELAY_MS);

    const progress = Math.min(100, Math.round(((i + CONCURRENCY) / toDownload.length) * 100));
    process.stdout.write(`\r   下載進度: ${progress}% (${succeeded + failed}/${toDownload.length})`);
  }

  console.log(`\n   ✅ 下載完成: 成功 ${succeeded}, 失敗 ${failed}`);
}

// ── Step 2: Run scans ───────────────────────────────────────────────────

async function runScans(market: 'TW' | 'CN') {
  const date = getTodayDate(market);

  if (!isWeekday(date, market)) {
    console.log(`\n🔇 [${market}] ${date} 非交易日，跳過掃描`);
    return;
  }

  console.log(`\n🔍 [${market}] 掃描 ${date}...`);

  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
  const stocks = await scanner.getStockList();
  const mtfThresholds = { ...ZHU_V1.thresholds, multiTimeframeFilter: true };

  // ── Long daily ──
  const { results: longDaily, marketTrend } = await scanner.scanSOP(stocks, date);
  await saveScanSession({
    id: `${market}-long-daily-${date}-${Date.now()}`,
    market, date, direction: 'long',
    multiTimeframeEnabled: false,
    scanTime: new Date().toISOString(),
    resultCount: longDaily.length, results: longDaily,
  });

  // ── Long MTF ──
  let longMtfCount = 0;
  try {
    const { results: longMtf } = await scanner.scanSOP(stocks, date, mtfThresholds);
    await saveScanSession({
      id: `${market}-long-mtf-${date}-${Date.now()}`,
      market, date, direction: 'long',
      multiTimeframeEnabled: true,
      scanTime: new Date().toISOString(),
      resultCount: longMtf.length, results: longMtf,
    });
    longMtfCount = longMtf.length;
  } catch { /* non-fatal */ }

  // ── Short daily ──
  let shortDailyCount = 0;
  try {
    const { candidates: shortDaily } = await scanner.scanShortCandidates(stocks, date);
    await saveScanSession({
      id: `${market}-short-daily-${date}-${Date.now()}`,
      market, date, direction: 'short',
      multiTimeframeEnabled: false,
      scanTime: new Date().toISOString(),
      resultCount: shortDaily.length, results: shortDaily,
    });
    shortDailyCount = shortDaily.length;
  } catch { /* non-fatal */ }

  // ── Short MTF ──
  let shortMtfCount = 0;
  try {
    const { candidates: shortMtf } = await scanner.scanShortCandidates(stocks, date, mtfThresholds);
    await saveScanSession({
      id: `${market}-short-mtf-${date}-${Date.now()}`,
      market, date, direction: 'short',
      multiTimeframeEnabled: true,
      scanTime: new Date().toISOString(),
      resultCount: shortMtf.length, results: shortMtf,
    });
    shortMtfCount = shortMtf.length;
  } catch { /* non-fatal */ }

  console.log(
    `   ✅ trend=${marketTrend} ` +
    `long-d=${longDaily.length} long-m=${longMtfCount} ` +
    `short-d=${shortDailyCount} short-m=${shortMtfCount}`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const markets: ('TW' | 'CN')[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--market' && args[i + 1]) {
      const m = args[i + 1].toUpperCase();
      if (m === 'TW' || m === 'CN') markets.push(m);
      i++;
    }
  }

  // 預設兩個市場都掃
  const targetMarkets = markets.length > 0 ? markets : ['TW', 'CN'] as const;

  console.log(`\n🚀 每日掃描開始 — ${new Date().toISOString()}`);
  console.log(`   市場: ${targetMarkets.join(', ')}`);

  for (const market of targetMarkets) {
    try {
      await downloadCandles(market);
      await runScans(market);
    } catch (err) {
      console.error(`\n❌ [${market}] 失敗:`, err);
    }
  }

  console.log(`\n🎉 每日掃描完成 — ${new Date().toISOString()}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
