#!/usr/bin/env npx tsx
/**
 * download-blob-to-cache.ts
 *
 * 從 Vercel Blob 下載所有 CN 個股 K 線，合併成 backtest-candles-cn.json
 *
 * 需要環境變數: BLOB_READ_WRITE_TOKEN
 *
 * Usage:
 *   BLOB_READ_WRITE_TOKEN=xxx npx tsx scripts/download-blob-to-cache.ts
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import fs from 'fs';
import path from 'path';

const OUTPUT = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');
const BLOB_PREFIX = 'candles/CN/';

async function main() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.error('缺少 BLOB_READ_WRITE_TOKEN 環境變數');
    console.error('用法: BLOB_READ_WRITE_TOKEN=xxx npx tsx scripts/download-blob-to-cache.ts');
    process.exit(1);
  }

  const { list } = await import('@vercel/blob');

  console.log('列出 Vercel Blob 中的 CN K 線檔案...');

  // 分頁列出所有 Blob
  const allBlobs: { url: string; pathname: string }[] = [];
  let cursor: string | undefined;
  do {
    const result = await list({
      prefix: BLOB_PREFIX,
      limit: 1000,
      cursor,
      token,
    });
    allBlobs.push(...result.blobs.map(b => ({ url: b.url, pathname: b.pathname })));
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  console.log(`找到 ${allBlobs.length} 個 CN K 線檔案`);
  if (allBlobs.length === 0) {
    console.error('Blob 中沒有 CN K 線檔案！');
    process.exit(1);
  }

  // 批次下載
  const stocks: Record<string, { name: string; candles: any[] }> = {};
  const BATCH = 20;
  let ok = 0, fail = 0;
  const start = Date.now();

  for (let i = 0; i < allBlobs.length; i += BATCH) {
    const batch = allBlobs.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (blob) => {
        const res = await fetch(blob.url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as any;
        const symbol = blob.pathname.replace(BLOB_PREFIX, '').replace('.json', '');
        return { symbol, name: data.name ?? symbol, candles: data.candles ?? [] };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.candles.length > 0) {
        stocks[r.value.symbol] = { name: r.value.name, candles: r.value.candles };
        ok++;
      } else {
        fail++;
      }
    }

    const done = Math.min(i + BATCH, allBlobs.length);
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r  [${done}/${allBlobs.length}] ok=${ok} fail=${fail} | ${elapsed}s`);
  }

  console.log('');
  console.log(`下載完成: ${ok} 成功, ${fail} 失敗`);

  // 確保輸出目錄存在
  const dir = path.dirname(OUTPUT);
  if (!existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 寫入合併檔案
  const output = {
    generatedAt: new Date().toISOString(),
    stockCount: Object.keys(stocks).length,
    stocks,
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(output));
  const sizeMB = (fs.statSync(OUTPUT).size / 1024 / 1024).toFixed(1);
  console.log(`已寫入 ${OUTPUT} (${sizeMB} MB, ${Object.keys(stocks).length} 支股票)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
