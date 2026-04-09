/**
 * 將本地 K 線資料上傳到 Vercel Blob（透過 /api/admin/upload-candles）
 *
 * 使用方法：
 *   npx tsx scripts/upload-candles-to-blob.ts [--tw-only | --cn-only]
 *
 * 環境變數（自動從 .env.local 讀取，或直接帶入）：
 *   UPLOAD_SECRET  上傳密鑰（已設在 Vercel）
 *   UPLOAD_URL     Vercel 部署網址（預設 stock-replay-tau.vercel.app）
 */

import { readdir, readFile } from 'fs/promises';
import path from 'path';

const SECRET = process.env.UPLOAD_SECRET ?? '607570edf11c0e1fcd2a9311c8832a0c820938d5';
const BASE_URL = process.env.UPLOAD_URL ?? 'https://stock-replay-5f24.vercel.app';
const ENDPOINT = `${BASE_URL}/api/admin/upload-candles`;

const DATA_ROOT = path.join(process.cwd(), 'data', 'candles');
const BATCH_SIZE = 20;   // 每次 POST 幾個檔案
const CONCURRENCY = 3;   // 同時幾個 POST 請求

async function uploadBatch(files: Array<{ key: string; content: string }>): Promise<{ ok: number; failed: number }> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-upload-secret': SECRET,
    },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function uploadMarket(market: 'TW' | 'CN') {
  const dir = path.join(DATA_ROOT, market);
  const allFiles = (await readdir(dir)).filter(f => f.endsWith('.json'));

  console.log(`\n📤 ${market}：${allFiles.length} 個檔案`);

  let totalOk = 0;
  let totalFailed = 0;

  // 切成 BATCH_SIZE 個一組，再以 CONCURRENCY 並行 POST
  for (let i = 0; i < allFiles.length; i += BATCH_SIZE * CONCURRENCY) {
    const groupEnd = Math.min(i + BATCH_SIZE * CONCURRENCY, allFiles.length);
    const group = allFiles.slice(i, groupEnd);

    // 把 group 再切成 CONCURRENCY 個批次
    const batches: string[][] = [];
    for (let j = 0; j < group.length; j += BATCH_SIZE) {
      batches.push(group.slice(j, j + BATCH_SIZE));
    }

    await Promise.allSettled(
      batches.map(async (batch) => {
        const files = await Promise.all(
          batch.map(async (filename) => ({
            key: `candles/${market}/${filename}`,
            content: await readFile(path.join(dir, filename), 'utf-8'),
          }))
        );
        try {
          const result = await uploadBatch(files);
          totalOk += result.ok;
          totalFailed += result.failed;
        } catch (err) {
          totalFailed += batch.length;
          console.error(`\n  ❌ batch error: ${err}`);
        }
      })
    );

    const progress = Math.round((groupEnd / allFiles.length) * 100);
    process.stdout.write(
      `\r  進度: ${totalOk} 成功 / ${totalFailed} 失敗 / ${allFiles.length} 總計 (${progress}%)`
    );
  }

  console.log(`\n✅ ${market} 完成：${totalOk} 成功, ${totalFailed} 失敗`);
}

async function main() {
  const args = process.argv.slice(2);
  const markets: Array<'TW' | 'CN'> = args.includes('--cn-only') ? ['CN']
    : args.includes('--tw-only') ? ['TW']
    : ['TW', 'CN'];

  console.log(`🚀 上傳 K 線到 Vercel Blob`);
  console.log(`   目標: ${ENDPOINT}`);
  console.log(`   市場: ${markets.join(', ')}`);

  const start = Date.now();
  for (const market of markets) {
    await uploadMarket(market);
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`\n🎉 完成！耗時 ${elapsed} 秒`);
}

main().catch(err => {
  console.error('❌ 失敗:', err);
  process.exit(1);
});
