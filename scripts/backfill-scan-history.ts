/**
 * 用 L1 歷史資料 + 當前掃描程式碼，重跑過去 N 個交易日的 scan，產出正確 L4。
 *
 * 為什麼需要：
 *   PR #35/#42 加了 Step 1 池子 + 多頭軌字母過池子的 gate。但 PR 是 5/9 15:22
 *   merge 的，5/9 cron 已在 14:00 跑過（沒這 feature），5/10/11 是非交易日。
 *   所以 production Blob 過去 letter sessions **沒有** 經過 Step 1 gate；step1-
 *   pool 也從未被任何 production cron 寫入過。
 *
 * 用同一條 ScanPipeline (production cron 用的) 重跑：
 *   - 每個 (market, date) 跑一次 runScanPipeline，帶 buyMethods=B-Q
 *   - 內部依序：scanSOP（寫 step1-pool + daily session）→ 13 個 scanBuyMethod
 *     （多頭軌讀池子過 gate；反轉軌+戰法軌全市場掃）
 *   - allowOverwritePostClose 自動 true（saveScanSession 對 post_close 預設覆蓋）
 *
 * Usage:
 *   # local dev fs（測試用）
 *   npx tsx scripts/backfill-scan-history.ts --days 20
 *
 *   # production Blob
 *   set -a; source .env.local; set +a
 *   VERCEL=1 npx tsx scripts/backfill-scan-history.ts --blob --apply
 *
 *   # 縮小範圍測試
 *   ... --days 1 --market TW
 *   ... --date 2026-05-08 --market TW
 *
 * 注意：每個 (market, date) 跑 ~100-250s。20 天 × 2 市場 ~100 分鐘。
 */

import { isTradingDay } from '../lib/utils/tradingDay';
import { runScanPipeline } from '../lib/scanner/ScanPipeline';
import type { MarketId } from '../lib/scanner/types';

const ALL_BUY_METHODS = ['B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'] as const;
type BuyMethod = (typeof ALL_BUY_METHODS)[number];

function getLastNTradingDays(n: number, market: MarketId): string[] {
  const result: string[] = [];
  const utc8Now = new Date(Date.now() + 8 * 3600_000);
  const todayStr = utc8Now.toISOString().split('T')[0];
  const check = new Date(todayStr + 'T12:00:00');
  while (result.length < n) {
    const dateStr = check.toISOString().split('T')[0];
    if (isTradingDay(dateStr, market)) {
      result.push(dateStr);
    }
    check.setDate(check.getDate() - 1);
    if (result.length === 0 && (todayStr.localeCompare(dateStr) > 60 * 60)) break; // safety
  }
  return result.reverse();
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const useBlob = process.argv.includes('--blob');
  const days = Number(arg('days', '20'));
  const marketArg = arg('market') as MarketId | undefined;
  const singleDate = arg('date');

  if (useBlob) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      console.error('--blob 模式需要 BLOB_READ_WRITE_TOKEN（請 source .env.local）');
      process.exit(1);
    }
    if (!process.env.VERCEL) process.env.VERCEL = '1';
  }

  const markets: MarketId[] = marketArg ? [marketArg] : ['TW', 'CN'];

  // 列出每個 market 要跑的日期
  const plan: Array<{ market: MarketId; date: string }> = [];
  for (const market of markets) {
    if (singleDate) {
      if (!isTradingDay(singleDate, market)) {
        console.warn(`[${market}] ${singleDate} 不是交易日，skip`);
        continue;
      }
      plan.push({ market, date: singleDate });
    } else {
      const dates = getLastNTradingDays(days, market);
      for (const date of dates) plan.push({ market, date });
    }
  }

  console.log(`\n=== Backfill scan history · ${useBlob ? 'BLOB' : 'LOCAL'} · ${apply ? 'APPLY' : 'DRY-RUN'} ===`);
  console.log(`Targets: ${plan.length} (markets=${markets.join(',')}, days=${singleDate ? 1 : days})\n`);
  for (const p of plan) console.log(`  ${p.market} ${p.date}`);

  if (!apply) {
    console.log('\n(dry-run) 加 --apply 才會實際重跑。預估每個 (market, date) 100-250s。');
    return;
  }

  let ok = 0;
  let failed = 0;
  const startAll = Date.now();
  for (const { market, date } of plan) {
    const start = Date.now();
    console.log(`\n--- ${market} ${date} ---`);
    try {
      const result = await runScanPipeline({
        market,
        date,
        sessionType: 'post_close',
        directions: ['long', 'short'],
        mtfModes: ['daily', 'mtf'],
        buyMethods: ALL_BUY_METHODS as unknown as BuyMethod[],
        force: true,
        deadlineMs: 280_000, // 略低於 vercel 300s 上限
      });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const summary = Object.entries(result.counts).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`✓ ${market} ${date} (${elapsed}s) ${summary}${result.timedOut ? ' ⚠ timed out' : ''}`);
      ok++;
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.error(`✗ ${market} ${date} (${elapsed}s) FAILED: ${err}`);
      failed++;
    }
  }

  const totalMin = ((Date.now() - startAll) / 1000 / 60).toFixed(1);
  console.log(`\n=== Done · ${ok} ok / ${failed} failed · total ${totalMin} min ===`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
