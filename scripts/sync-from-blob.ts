#!/usr/bin/env npx tsx
/**
 * sync-from-blob.ts — 從 Vercel Blob 拉取 K 線到本地
 *
 * 用法：
 *   export $(grep -v '^#' .env.local | xargs)
 *   npx tsx scripts/sync-from-blob.ts --market TW          # 只拉落後的
 *   npx tsx scripts/sync-from-blob.ts --market CN          # 只拉落後的
 *   npx tsx scripts/sync-from-blob.ts --market TW --all    # 全量覆蓋
 *   npx tsx scripts/sync-from-blob.ts --market TW --market CN  # 兩個市場
 */

import { list, get } from '@vercel/blob';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const hasFlag = (name: string) => args.includes(`--${name}`);

// 支援多個 --market
const markets: Array<'TW' | 'CN'> = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--market' && args[i + 1]) {
    const m = args[i + 1].toUpperCase();
    if (m === 'TW' || m === 'CN') markets.push(m);
  }
}
if (markets.length === 0) {
  console.error('用法: npx tsx scripts/sync-from-blob.ts --market TW [--market CN] [--all]');
  process.exit(1);
}

const ALL = hasFlag('all');
const BATCH = 10;
const DATA_ROOT = path.join(process.cwd(), 'data', 'candles');
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Helpers ──────────────────────────────────────────────────────────────────

interface CandleFileData {
  symbol: string;
  lastDate: string;
  updatedAt: string;
  candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
  sealedDate?: string;
}

function getLocalLastDate(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = require('fs').readFileSync(filePath, 'utf-8');
    const data: CandleFileData = JSON.parse(raw);
    const last = data.candles?.[data.candles.length - 1];
    return last?.date ?? null;
  } catch {
    return null;
  }
}

async function blobGetText(pathname: string): Promise<string | null> {
  const result = await get(pathname, { access: 'private' });
  if (!result || !result.stream) return null;
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function syncMarket(market: 'TW' | 'CN'): Promise<void> {
  console.log(`\n📥 ${market}: 列舉 Blob 檔案...`);

  // 列出 Blob 中所有 K 線檔案
  const prefix = `candles/${market}/`;
  const blobFiles: Array<{ pathname: string; uploadedAt: Date }> = [];
  let cursor: string | undefined;
  do {
    const result = await list({ prefix, limit: 100, cursor });
    blobFiles.push(...result.blobs.map(b => ({ pathname: b.pathname, uploadedAt: b.uploadedAt })));
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  console.log(`   Blob 共 ${blobFiles.length} 個檔案`);

  // 確保本地目錄存在
  const localDir = path.join(DATA_ROOT, market);
  if (!existsSync(localDir)) {
    await mkdir(localDir, { recursive: true });
  }

  // 比對哪些需要下載
  let toDownload: string[] = [];

  if (ALL) {
    toDownload = blobFiles.map(b => b.pathname);
    console.log(`   全量模式: 下載全部 ${toDownload.length} 個`);
  } else {
    // 只下載 Blob 比本地新的
    for (const blob of blobFiles) {
      const filename = path.basename(blob.pathname);
      const localFile = path.join(localDir, filename);
      const localLast = getLocalLastDate(localFile);

      if (!localLast) {
        // 本地不存在
        toDownload.push(blob.pathname);
      } else {
        // 需要讀 Blob 的 lastDate 來比較 — 但那太慢了
        // 改用 uploadedAt：如果 Blob 更新時間比本地檔案修改時間新，就下載
        try {
          const stat = require('fs').statSync(localFile);
          if (blob.uploadedAt > stat.mtime) {
            toDownload.push(blob.pathname);
          }
        } catch {
          toDownload.push(blob.pathname);
        }
      }
    }
    console.log(`   增量模式: ${toDownload.length} 個需更新（${blobFiles.length - toDownload.length} 個已最新）`);
  }

  if (toDownload.length === 0) {
    console.log(`   ✅ ${market} 本地已是最新`);
    return;
  }

  // 分批下載
  let ok = 0, fail = 0, skipped = 0;
  const startTime = Date.now();

  for (let i = 0; i < toDownload.length; i += BATCH) {
    const batch = toDownload.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (pathname) => {
        const text = await blobGetText(pathname);
        if (!text) throw new Error(`空內容: ${pathname}`);

        // 驗證 JSON 合法性
        const data: CandleFileData = JSON.parse(text);
        if (!data.candles || data.candles.length === 0) {
          throw new Error(`無K線: ${pathname}`);
        }

        const filename = path.basename(pathname);
        await writeFile(path.join(localDir, filename), text, 'utf-8');
        return data.candles.length;
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled') ok++;
      else {
        fail++;
        console.error('  ❌', (r.reason as Error)?.message?.slice(0, 80));
      }
    }

    const done = i + batch.length;
    if (done % 100 === 0 || done === toDownload.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  [${done}/${toDownload.length}] ok=${ok} fail=${fail} | ${elapsed}s`);
    }

    if (i + BATCH < toDownload.length) await sleep(200);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ ${market} 同步完成（${elapsed}s）: ${ok} 成功, ${fail} 失敗`);
}

async function main(): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('❌ BLOB_READ_WRITE_TOKEN 環境變數未設定');
    console.error('   請先執行: export $(grep -v "^#" .env.local | xargs)');
    process.exit(1);
  }

  for (const market of markets) {
    await syncMarket(market);
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
