/**
 * 修復 L1 中的假 K 棒 — 從 audit-l1-zero-volume-spike 清單刪除指定的 K 棒。
 *
 * 修復策略：直接從 candles 陣列中刪除這些 (symbol, date) 的 K 棒。
 * 因為這些都是 vol=0 的假 K 棒，旁邊的真 K 棒原本就會無縫連續。
 *
 * 用法：
 *   tsx scripts/repair-l1-zero-volume-spike.ts [--report PATH] [--dry-run]
 */

import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const CANDLES_ROOT = path.join(REPO_ROOT, 'data', 'candles');

interface PollutionEntry {
  symbol: string;
  market: 'TW' | 'CN';
  date: string;
  prevClose: number;
  close: number;
  volume: number;
}

interface Report {
  generatedAt: string;
  total: number;
  bySymbol: Record<string, PollutionEntry[]>;
}

async function main() {
  const args = process.argv.slice(2);
  // 預設 dry-run，要明確 --apply 才寫檔
  const dryRun = !args.includes('--apply');
  const reportPath = args.includes('--report')
    ? args[args.indexOf('--report') + 1]
    : `/Users/tzu-chienhsu/Desktop/rockstock/data/reports/l1-zero-volume-spike-${new Date().toISOString().slice(0, 10)}.json`;

  const raw = await fs.readFile(reportPath, 'utf-8');
  const report = JSON.parse(raw) as Report;

  console.log(`Report: ${reportPath}`);
  console.log(`Total bad candles: ${report.total}`);
  console.log(`Affected symbols: ${Object.keys(report.bySymbol).length}`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN（不寫檔）' : 'WRITE（會修改 L1）'}\n`);

  let totalRemoved = 0;
  let filesWritten = 0;

  for (const [symbol, list] of Object.entries(report.bySymbol)) {
    const market = list[0].market;
    const file = path.join(CANDLES_ROOT, market, `${symbol}.json`);
    const badDates = new Set(list.map((p) => p.date));

    let l1: { symbol: string; candles: Array<{ date: string; volume?: number; close: number }>; lastDate?: string };
    try {
      l1 = JSON.parse(await fs.readFile(file, 'utf-8'));
    } catch (err) {
      console.error(`  ✗ ${symbol}: 讀檔失敗：${err}`);
      continue;
    }

    const before = l1.candles.length;
    const filtered = l1.candles.filter((c) => !badDates.has(c.date));
    const removed = before - filtered.length;
    totalRemoved += removed;

    if (removed === 0) {
      console.log(`  - ${symbol}: 已修復或日期不在 L1，skip`);
      continue;
    }

    console.log(`  ✓ ${symbol}: ${before} → ${filtered.length} (移除 ${removed} 根假 K)`);

    if (!dryRun) {
      l1.candles = filtered;
      // lastDate 重新計算
      if (filtered.length > 0) {
        l1.lastDate = filtered[filtered.length - 1].date;
      }
      await fs.writeFile(file, JSON.stringify(l1));
      filesWritten++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`總計移除：${totalRemoved} 根假 K 棒`);
  if (!dryRun) {
    console.log(`寫回檔案：${filesWritten} 個`);
  } else {
    console.log(`Dry-run 完成，沒寫檔。確認無誤後加 --no-dry-run 並重跑。`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
