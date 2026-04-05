/**
 * 手動下載全市場 K 線到本地（支援增量模式）
 *
 * 用法：
 *   npx tsx scripts/download-candles.ts --market TW
 *   npx tsx scripts/download-candles.ts --market CN
 *   npx tsx scripts/download-candles.ts --market TW --market CN
 *   npx tsx scripts/download-candles.ts --market CN --force   (強制全部重新下載)
 */

import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { saveLocalCandles, batchCheckFreshness, getLocalCandleDir } from '../lib/datasource/LocalCandleStore';
import { readdirSync } from 'fs';

const CONCURRENCY = 8;
const BATCH_DELAY_MS = 300;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * 取得最近一個交易日的日期（跳過週末）
 */
function getLastTradingDate(): string {
  const now = new Date();
  const dow = now.getDay();
  if (dow === 0) now.setDate(now.getDate() - 2); // 週日 → 週五
  else if (dow === 6) now.setDate(now.getDate() - 1); // 週六 → 週五
  return now.toISOString().split('T')[0];
}

async function downloadMarket(market: 'TW' | 'CN', force: boolean) {
  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
  const startTime = Date.now();
  const lastTradingDate = getLastTradingDate();

  console.log(`\n📥 開始下載 ${market} 市場 K 線數據...`);
  console.log(`   模式: ${force ? '強制全部下載' : '增量（跳過已有最新數據的）'}`);
  console.log(`   基準日期: ${lastTradingDate}\n`);

  const stocks = await scanner.getStockList();
  console.log(`  股票清單: ${stocks.length} 檔`);

  // 增量模式：先批量檢查哪些需要下載（容忍 3 個交易日的落差）
  let toDownload = stocks;
  let skipped = 0;
  if (!force) {
    const symbols = stocks.map(s => s.symbol);
    const { fresh, stale, missing } = await batchCheckFreshness(symbols, market, lastTradingDate, 3);
    const skipSet = new Set([...fresh, ...stale]);
    toDownload = stocks.filter(s => !skipSet.has(s.symbol));
    skipped = fresh.length + stale.length;
    console.log(`  已有最新數據: ${fresh.length} 檔，3日內小落差: ${stale.length} 檔（共 ${skipped} 檔跳過）`);
    console.log(`  需要下載: ${missing.length} 檔\n`);
  }

  if (toDownload.length === 0) {
    console.log('✅ 全部數據已是最新，無需下載！');
    return;
  }

  let succeeded = 0;
  let failed = 0;
  const failedSymbols: string[] = [];

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

    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      if (r.status === 'fulfilled' && r.value > 0) {
        succeeded++;
      } else {
        failed++;
        if (failedSymbols.length < 20) failedSymbols.push(batch[j].symbol);
      }
    }

    if (i + CONCURRENCY < toDownload.length) await sleep(BATCH_DELAY_MS);

    // 進度條
    const progress = Math.min(100, Math.round(((i + CONCURRENCY) / toDownload.length) * 100));
    const bar = '█'.repeat(Math.floor(progress / 2)) + '░'.repeat(50 - Math.floor(progress / 2));
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`\r  [${bar}] ${progress}% (${succeeded + failed}/${toDownload.length}) ${elapsed}s`);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // 統計本地檔案數
  let fileCount = 0;
  try {
    fileCount = readdirSync(getLocalCandleDir(market)).filter(f => f.endsWith('.json')).length;
  } catch { /* dir might not exist yet */ }

  console.log(`\n\n✅ ${market} 下載完成`);
  console.log(`   成功: ${succeeded}  失敗: ${failed}  跳過: ${skipped}  耗時: ${duration}s`);
  console.log(`   本地檔案總數: ${fileCount}`);
  if (failedSymbols.length > 0) {
    console.log(`   失敗樣本: ${failedSymbols.slice(0, 10).join(', ')}${failedSymbols.length > 10 ? '...' : ''}`);
  }
}

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

  if (markets.length === 0) {
    console.log('用法: npx tsx scripts/download-candles.ts --market TW [--market CN] [--force]');
    process.exit(1);
  }

  const force = args.includes('--force');

  for (const market of markets) {
    await downloadMarket(market, force);
  }

  console.log('\n🎉 全部完成！\n');
}

main().catch(err => {
  console.error('❌ 下載失敗:', err);
  process.exit(1);
});
