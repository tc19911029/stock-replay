#!/usr/bin/env npx tsx
/**
 * download-scan-blob-to-local.ts
 *
 * 把 Vercel Blob 上的 step1-pool + scans (post_close + intraday) 過去 N 天下載
 * 到 local data/ 資料夾。為「Vercel 退訂、本地化」遷移用。
 *
 * 路徑對應：
 *   step1-pool/{market}/{date}.json
 *     → data/step1-pool/{market}/{date}.json
 *   scans/{market}/{dir}/{mtf}/{date}.json (post_close)
 *     → data/scan-{market}-{dir}-{mtf}-{date}.json
 *   scans/{market}/{dir}/{mtf}/{date}/intraday/{HHMMSS}.json
 *     → data/scan-{market}-{dir}-{mtf}-{date}-intraday-{HHMMSS}.json
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/download-scan-blob-to-local.ts            # dry-run，列計劃
 *   npx tsx scripts/download-scan-blob-to-local.ts --apply    # 實際下載
 *   ... --days 30                                              # 改範圍（預設 20）
 *   ... --include-intraday                                     # 連 intraday 一起拉（預設只拉 post_close + step1-pool）
 */

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import * as path from 'path';

const APPLY = process.argv.includes('--apply');
const INCLUDE_INTRADAY = process.argv.includes('--include-intraday');

function arg(name: string, fallback: string): string {
  const i = process.argv.findIndex((a) => a === `--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

const DAYS = Number(arg('days', '20'));
const DATA_DIR = path.join(process.cwd(), 'data');

interface BlobItem {
  url: string;
  pathname: string;
  size?: number;
}

interface DownloadTask {
  blobUrl: string;
  blobPathname: string;
  localPath: string;
  category: 'step1-pool' | 'post_close' | 'intraday';
}

async function listAll(prefix: string, token: string): Promise<BlobItem[]> {
  const { list } = await import('@vercel/blob');
  const out: BlobItem[] = [];
  let cursor: string | undefined;
  do {
    const r = await list({ prefix, cursor, limit: 1000, token });
    out.push(
      ...r.blobs.map((b) => ({
        url: b.url,
        pathname: b.pathname,
        size: b.size,
      })),
    );
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}

function withinDateRange(dateStr: string, cutoffDate: string): boolean {
  return dateStr >= cutoffDate;
}

function blobToLocalPath(blob: BlobItem): { localPath: string; category: DownloadTask['category'] } | null {
  // step1-pool/{market}/{date}.json
  const poolMatch = blob.pathname.match(/^step1-pool\/(TW|CN)\/(\d{4}-\d{2}-\d{2})\.json$/);
  if (poolMatch) {
    return {
      category: 'step1-pool',
      localPath: path.join(DATA_DIR, 'step1-pool', poolMatch[1], `${poolMatch[2]}.json`),
    };
  }
  // scans/{market}/{dir}/{mtf}/{date}/intraday/{HHMMSS or HHMM}.json
  const intradayMatch = blob.pathname.match(
    /^scans\/(TW|CN)\/([^/]+)\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/intraday\/(\d{4}|\d{6})\.json$/,
  );
  if (intradayMatch) {
    const [, market, dir, mtf, date, time] = intradayMatch;
    return {
      category: 'intraday',
      localPath: path.join(DATA_DIR, `scan-${market}-${dir}-${mtf}-${date}-intraday-${time}.json`),
    };
  }
  // scans/{market}/{dir}/{mtf}/{date}.json (post_close)
  const postMatch = blob.pathname.match(
    /^scans\/(TW|CN)\/([^/]+)\/([^/]+)\/(\d{4}-\d{2}-\d{2})\.json$/,
  );
  if (postMatch) {
    const [, market, dir, mtf, date] = postMatch;
    return {
      category: 'post_close',
      localPath: path.join(DATA_DIR, `scan-${market}-${dir}-${mtf}-${date}.json`),
    };
  }
  return null;
}

async function main() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.error('缺少 BLOB_READ_WRITE_TOKEN（請 source .env.local）');
    process.exit(1);
  }

  const cutoff = new Date(Date.now() + 8 * 3600_000);
  cutoff.setDate(cutoff.getDate() - DAYS - 5); // 5 天 buffer 防週末/假日
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  console.log(`\n=== Blob → Local 下載 · ${APPLY ? 'APPLY' : 'DRY-RUN'} ===`);
  console.log(`過去 ${DAYS} 天 (cutoff date >= ${cutoffDate})`);
  console.log(`Intraday: ${INCLUDE_INTRADAY ? 'INCLUDED' : 'SKIPPED (post_close 才是 ground truth)'}`);
  console.log(`寫入目錄: ${DATA_DIR}\n`);

  const allBlobs: BlobItem[] = [];
  for (const prefix of ['step1-pool/', 'scans/TW/', 'scans/CN/']) {
    process.stdout.write(`  列出 ${prefix} ... `);
    const blobs = await listAll(prefix, token);
    allBlobs.push(...blobs);
    console.log(`${blobs.length} 個`);
  }

  // 規則：對應到 local + 在日期範圍內
  const tasks: DownloadTask[] = [];
  let skippedOldDate = 0;
  let skippedIntraday = 0;
  let skippedUnknown = 0;
  for (const blob of allBlobs) {
    const mapping = blobToLocalPath(blob);
    if (!mapping) {
      skippedUnknown++;
      continue;
    }
    if (mapping.category === 'intraday' && !INCLUDE_INTRADAY) {
      skippedIntraday++;
      continue;
    }
    // 檢查日期範圍
    const dateMatch = blob.pathname.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch && !withinDateRange(dateMatch[1], cutoffDate)) {
      skippedOldDate++;
      continue;
    }
    tasks.push({
      blobUrl: blob.url,
      blobPathname: blob.pathname,
      localPath: mapping.localPath,
      category: mapping.category,
    });
  }

  // 統計
  const byCategory = tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.category] = (acc[t.category] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n總共 Blob: ${allBlobs.length}`);
  console.log(`  → 不認識路徑       : ${skippedUnknown}`);
  console.log(`  → 太舊 (< ${cutoffDate}) : ${skippedOldDate}`);
  console.log(`  → intraday 略過    : ${skippedIntraday}`);
  console.log(`要下載: ${tasks.length}`);
  for (const [cat, n] of Object.entries(byCategory)) console.log(`  ${cat}: ${n}`);

  if (!APPLY) {
    console.log('\n(dry-run) 加 --apply 才會實際下載。');
    return;
  }

  // 並行下載
  const BATCH = 20;
  let ok = 0;
  let fail = 0;
  let skippedExisting = 0;
  const start = Date.now();

  for (let i = 0; i < tasks.length; i += BATCH) {
    const batch = tasks.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (t) => {
        // 確保資料夾存在
        await fs.mkdir(path.dirname(t.localPath), { recursive: true });
        // 下載
        const res = await fetch(t.blobUrl, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${t.blobPathname}`);
        const data = await res.text();
        await fs.writeFile(t.localPath, data);
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') ok++;
      else fail++;
    }
    const done = Math.min(i + BATCH, tasks.length);
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r  [${done}/${tasks.length}] ok=${ok} fail=${fail} skipped=${skippedExisting} | ${elapsed}s`);
  }
  console.log('');

  console.log(`\n下載完成: ${ok} 成功, ${fail} 失敗`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
