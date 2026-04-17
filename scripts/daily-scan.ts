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
import { runScanPipeline } from '../lib/scanner/ScanPipeline';
import { buildTurnoverRank } from '../lib/scanner/TurnoverRank';
import { saveLocalCandles, batchCheckFreshness, getLocalCandleDir } from '../lib/datasource/LocalCandleStore';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { readIntradaySnapshot } from '../lib/datasource/IntradayCache';
import { spotCheckL1 } from '../lib/datasource/L1SpotCheck';
import { isWeekday } from '../lib/utils/tradingDay';

const CONCURRENCY = 8;
const BATCH_DELAY_MS = 300;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function getTodayDate(market: 'TW' | 'CN'): string {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  return new Date().toLocaleString('sv-SE', { timeZone: tz }).split(' ')[0];
}

// ── Step 0: Inject L2 snapshot into L1 ─────────────────────────────────

/**
 * 收盤後 L2 快照就是今日最終 K 棒（開高低收量）。
 * 先注入 L1，讓 downloadCandles() 把這些股票視為「已是最新」跳過 API，
 * 大幅降低對 EastMoney/Yahoo API 的依賴，VPN/API 斷線也不影響掃描完整性。
 */
async function injectL2IntoL1(market: 'TW' | 'CN') {
  const date = getTodayDate(market);
  console.log(`\n💉 [${market}] Step 0: 從 L2 快照注入今日 K 棒到 L1...`);

  const snap = await readIntradaySnapshot(market, date);
  if (!snap || snap.quotes.length === 0) {
    console.log(`   ⚠️  L2 快照不存在或為空（${date}），跳過注入`);
    return;
  }
  if (snap.date !== date) {
    console.log(`   ⚠️  L2 快照日期 ${snap.date} ≠ 今日 ${date}，跳過注入`);
    return;
  }

  const quotes = snap.quotes.filter(q => q.close > 0);
  let injected = 0;
  let skipped = 0;

  const INJECT_CONCURRENCY = 30;
  for (let i = 0; i < quotes.length; i += INJECT_CONCURRENCY) {
    const batch = quotes.slice(i, i + INJECT_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (q) => {
        const symbol = q.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
        const existing = await readCandleFile(symbol, market);
        if (!existing || existing.lastDate >= date) {
          skipped++;
          return;
        }
        // 追加今日 K 棒到既有 L1 歷史序列
        await saveLocalCandles(symbol, market, [
          ...existing.candles,
          { date, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume },
        ]);
        injected++;
      })
    );
  }

  console.log(`   ✅ 注入完成: ${injected} 支已注入, ${skipped} 支跳過（已最新或無 L1）`);

  // Step 0.5: 抽查注入的數據是否正確
  if (injected > 0) {
    console.log(`\n🔬 [${market}] Step 0.5: L1 抽查（Yahoo 交叉核驗）...`);
    const allSymbols = quotes.map(q => q.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, ''));
    await spotCheckL1(market, date, allSymbols);
  }
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

// ── Step 1.5: Build turnover rank index (前 N 大成交額) ────────────────

async function buildRankIndex(market: 'TW' | 'CN') {
  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
  const stocks = await scanner.getStockList();

  console.log(`\n📊 [${market}] Step 1.5: 計算成交額排名（前 500）...`);
  const index = await buildTurnoverRank(market, stocks, 500);
  console.log(`   ✅ 寫入 data/turnover-rank/${market}.json — ${index.symbols.length} 支，日期 ${index.date}`);
}

// ── Step 2: Run scans (via ScanPipeline) ───────────────────────────────

async function runScans(market: 'TW' | 'CN') {
  const date = getTodayDate(market);

  if (!isWeekday(date, market)) {
    console.log(`\n🔇 [${market}] ${date} 非交易日，跳過掃描`);
    return;
  }

  console.log(`\n🔍 [${market}] 掃描 ${date}...`);

  const result = await runScanPipeline({
    market,
    date,
    sessionType: 'post_close',
    directions: ['long', 'short'],
    mtfModes: ['daily', 'mtf'],
    force: true,
    deadlineMs: 600_000, // 本地不受 Vercel 300s 限制
  });

  const summary = Object.entries(result.counts).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`   ✅ trend=${result.marketTrend ?? '?'} ${summary}`);
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
      await injectL2IntoL1(market);
      await downloadCandles(market);
      await buildRankIndex(market);
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
