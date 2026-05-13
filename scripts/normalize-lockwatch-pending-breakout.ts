/**
 * 對齊書本 Part 11-1 第 7 位置：
 *   - 移除所有 currentStage='pending-breakout' 紀錄（書本沒這概念）
 *   - currentStage='entry-signal' → 'observation'（兩段升級已 deprecated）
 *
 * 範圍：data/lock-watch/{TW,CN}/{date}.json，過去 N 天（預設 20）
 *
 * Usage:
 *   npx tsx scripts/normalize-lockwatch-pending-breakout.ts          # 預設 20 天
 *   npx tsx scripts/normalize-lockwatch-pending-breakout.ts --days 30
 *   npx tsx scripts/normalize-lockwatch-pending-breakout.ts --dry-run
 */

import { promises as fs } from 'fs';
import path from 'path';

interface LockWatchRecord {
  symbol: string;
  currentStage: string;
  history?: Array<{ date: string; event: string; detail?: string }>;
  [key: string]: unknown;
}

interface LockWatchSnapshot {
  market: string;
  date: string;
  records: LockWatchRecord[];
  lastUpdated?: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DAYS = Number(arg('days') ?? '20');
const DRY = process.argv.includes('--dry-run');

function cutoffDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function processMarket(market: 'TW' | 'CN', cutoff: string): Promise<void> {
  const dir = path.join(process.cwd(), 'data', 'lock-watch', market);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    console.log(`  ${market}: 無資料夾，skip`);
    return;
  }
  files.sort();
  const recent = files.filter((f) => f.replace(/\.json$/, '') >= cutoff);
  console.log(`\n📂 ${market}: ${recent.length}/${files.length} 個檔在過去 ${DAYS} 天 (cutoff=${cutoff})`);

  let totalPending = 0;
  let totalEntrySig = 0;
  let totalKept = 0;
  let touchedFiles = 0;

  for (const f of recent) {
    const fullPath = path.join(dir, f);
    const raw = await fs.readFile(fullPath, 'utf-8');
    const snap = JSON.parse(raw) as LockWatchSnapshot;
    const before = snap.records.length;

    let pendingCount = 0;
    let entrySigCount = 0;
    const normalized: LockWatchRecord[] = [];
    for (const r of snap.records) {
      if (r.currentStage === 'pending-breakout') {
        pendingCount++;
        continue; // 砍掉
      }
      if (r.currentStage === 'entry-signal') {
        entrySigCount++;
        normalized.push({
          ...r,
          currentStage: 'observation',
          history: [
            ...(r.history ?? []),
            {
              date: snap.date,
              event: 'normalize',
              detail: '0513 對齊書本：entry-signal stage 已 deprecated，改為 observation',
            },
          ],
        });
        continue;
      }
      normalized.push(r);
    }

    if (pendingCount === 0 && entrySigCount === 0) continue;
    touchedFiles++;
    totalPending += pendingCount;
    totalEntrySig += entrySigCount;
    totalKept += normalized.length;

    snap.records = normalized;
    snap.lastUpdated = new Date().toISOString();
    if (!DRY) {
      await fs.writeFile(fullPath, JSON.stringify(snap), 'utf-8');
    }
    console.log(
      `  ${f}: -${pendingCount} pending -${entrySigCount} entry-sig (${before}→${normalized.length})${DRY ? ' [dry]' : ''}`,
    );
  }

  console.log(
    `\n  ${market} 小計：碰 ${touchedFiles} 個檔，刪 ${totalPending} pending-breakout，改 ${totalEntrySig} entry-signal→observation，保留 ${totalKept} records`,
  );
}

async function main() {
  const cutoff = cutoffDate(DAYS);
  console.log(`🔧 normalize-lockwatch ${DRY ? '[DRY-RUN]' : '[APPLY]'} cutoff=${cutoff}`);
  await processMarket('TW', cutoff);
  await processMarket('CN', cutoff);
  console.log('\n✓ 完成');
}

main().catch((err) => {
  console.error('💥 failed:', err);
  process.exit(1);
});
