/**
 * Lockwatch 跨日 evolve backfill — 0513 audit C4 修法
 *
 * 問題：backfill-scan-history 不寫 lockwatch；scan-bm cron 只寫「今日新觸發」
 * 但沒呼叫 update-lockwatch evolve；導致過去 N 天 lockwatch snapshot 各自
 * 只含當天新觸發紀錄，沒有「昨日 observation → 今日延續」的演進邏輯。
 *
 * 流程：
 *   1. 找出指定市場過去 N 天的所有 lockwatch snapshot 日期
 *   2. 從最舊一天開始，逐日：
 *      a. 取 prev (前一天) snapshot 的 active records (observation/entry-signal/pending-breakout)
 *      b. 對每筆抓今日 K 線 → checkStructureBroken / updateLockWatch evolve
 *      c. 跟今日新觸發 records (scan-bm 已寫的) 合併
 *      d. 寫回今日 snapshot
 *   3. 同步到 Blob（如帶 --blob）
 *
 * Usage:
 *   npx tsx scripts/evolve-lockwatch-backfill.ts              # local fs，過去 20 天，TW+CN
 *   npx tsx scripts/evolve-lockwatch-backfill.ts --days 30
 *   npx tsx scripts/evolve-lockwatch-backfill.ts --market TW
 *   VERCEL=1 npx tsx scripts/evolve-lockwatch-backfill.ts --blob --apply
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import {
  loadLockWatchSnapshot,
  saveLockWatchSnapshot,
  listLockWatchDates,
} from '@/lib/storage/lockWatchStorage';
import {
  updateLockWatch,
  checkStructureBroken,
  markStructureBroken,
} from '@/lib/scanner/lockWatchManager';
import { loadLocalCandlesWithTolerance } from '@/lib/datasource/LocalCandleStore';
import { isTradingDay } from '@/lib/utils/tradingDay';
import type { MarketId } from '@/lib/scanner/types';

const INDEX_SYMBOL: Record<MarketId, string> = {
  TW: '^TWII',
  CN: '000001.SS',
};

function arg(name: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DAYS = Number(arg('days') ?? '20');
const MARKETS: MarketId[] = arg('market') ? [arg('market') as MarketId] : ['TW', 'CN'];
const DRY = process.argv.includes('--dry-run');
const IS_BLOB = process.env.VERCEL === '1' || process.argv.includes('--blob');

async function evolveDay(market: MarketId, prevDate: string, today: string): Promise<{
  evolved: number;
  todayNew: number;
  changed: number;
  written: number;
}> {
  const prev = await loadLockWatchSnapshot(market, prevDate);
  if (!prev) {
    return { evolved: 0, todayNew: 0, changed: 0, written: 0 };
  }
  const todaySnap = await loadLockWatchSnapshot(market, today);
  const todayNewRecords = todaySnap?.records ?? [];

  // 0513 fix：用 LocalCandleStore 讀本地 L1 K 線，不打外部 API（dev 拿不到 Yahoo/FinMind）
  // production cron 用 scanner.fetchCandles 是因為要拉「今日」即時資料；
  // backfill 跑歷史日，本地 L1 已有，直接讀。
  const indexResult = await loadLocalCandlesWithTolerance(INDEX_SYMBOL[market], market, today, 5).catch(() => null);
  const indexCandles = indexResult?.candles ?? [];

  let changed = 0;
  const newRecords = [];

  for (const r of prev.records) {
    // 保留終結紀錄
    if (
      r.currentStage === 'purchased' ||
      r.currentStage === 'revoked' ||
      r.currentStage === 'manually-removed' ||
      r.currentStage === 'structure-broken'
    ) {
      newRecords.push(r);
      continue;
    }
    try {
      const result = await loadLocalCandlesWithTolerance(r.symbol, market, today, 5);
      const candles = result?.candles ?? [];
      if (candles.length === 0) {
        newRecords.push(r);
        continue;
      }
      const structCheck = checkStructureBroken(r, candles);
      if (structCheck.broken) {
        const broken = markStructureBroken(r, today, structCheck.reason ?? '結構失效');
        newRecords.push(broken);
        changed++;
        continue;
      }
      const { changed: c, record: updated } = updateLockWatch(r, candles, indexCandles, today);
      newRecords.push(updated);
      if (c) changed++;
    } catch (err) {
      console.warn(`  ${r.symbol}: fetchCandles 失敗，保留原狀 (${String(err).slice(0, 60)})`);
      newRecords.push(r);
    }
  }

  // 合併今日新觸發（scan-bm 已寫的不重複）
  const evolvedKeys = new Set(newRecords.map((r) => `${r.symbol}-${r.triggerSignal}`));
  let todayNew = 0;
  for (const r of todayNewRecords) {
    const key = `${r.symbol}-${r.triggerSignal}`;
    if (!evolvedKeys.has(key)) {
      newRecords.push(r);
      todayNew++;
    }
  }

  let written = 0;
  if (!DRY) {
    await saveLockWatchSnapshot({
      market,
      date: today,
      records: newRecords,
      lastUpdated: new Date().toISOString(),
    });
    written = newRecords.length;
  }

  return { evolved: newRecords.length - todayNew, todayNew, changed, written };
}

async function processMarket(market: MarketId): Promise<void> {
  console.log(`\n📂 ${market} (${IS_BLOB ? 'Blob' : 'local fs'}${DRY ? ' DRY' : ''})`);

  const allDates = (await listLockWatchDates(market)).sort();  // oldest first
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const targetDates = allDates.filter((d) => d >= cutoffStr && isTradingDay(d, market));

  if (targetDates.length < 2) {
    console.log(`  跳過：只有 ${targetDates.length} 個交易日 (need ≥ 2)`);
    return;
  }

  console.log(`  涵蓋 ${targetDates.length} 個交易日：${targetDates[0]} → ${targetDates[targetDates.length - 1]}`);

  let totalChanged = 0;
  for (let i = 1; i < targetDates.length; i++) {
    const prevDate = targetDates[i - 1];
    const today = targetDates[i];
    const t0 = Date.now();
    const { evolved, todayNew, changed, written } = await evolveDay(market, prevDate, today);
    totalChanged += changed;
    console.log(
      `  ${today} ← ${prevDate}: evolved=${evolved} todayNew=${todayNew} changed=${changed} written=${written} (${Math.round((Date.now() - t0) / 1000)}s)`,
    );
  }

  console.log(`  ${market} 完成：總共 changed=${totalChanged}`);
}

async function main() {
  console.log(`🔄 evolve-lockwatch-backfill ${DRY ? '[DRY]' : '[APPLY]'} ${IS_BLOB ? 'Blob' : 'local'} days=${DAYS}`);
  for (const m of MARKETS) {
    await processMarket(m);
  }
  console.log('\n✓ 完成');
}

main().catch((err) => {
  console.error('💥 failed:', err);
  process.exit(1);
});
