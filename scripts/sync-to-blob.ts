#!/usr/bin/env npx tsx
/**
 * sync-to-blob.ts — 將修正過的 K 線檔案同步到 Vercel Blob
 *
 * 讀取 correct-candles.ts 產出的修正報告，只上傳有修改的檔案。
 *
 * 用法：
 *   export $(grep -v '^#' .env.local | xargs)
 *   npx tsx scripts/sync-to-blob.ts --report data/correction-report-TW-*.json
 *   npx tsx scripts/sync-to-blob.ts --market TW --all   # 上傳整個市場
 */

import { put } from '@vercel/blob';
import { readFile, readdir } from 'fs/promises';
import path from 'path';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const REPORT_PATH = getArg('report', '');
const MARKET = getArg('market', '') as 'TW' | 'CN' | '';
const ALL = hasFlag('all');
const BATCH = 10;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('❌ BLOB_READ_WRITE_TOKEN 環境變數未設定');
    console.error('   請先執行: export $(grep -v "^#" .env.local | xargs)');
    process.exit(1);
  }

  let files: string[] = [];
  let market: 'TW' | 'CN';

  if (REPORT_PATH) {
    // 從修正報告讀取要上傳的 symbol
    const reportRaw = await readFile(REPORT_PATH, 'utf-8');
    const report = JSON.parse(reportRaw) as {
      market: 'TW' | 'CN';
      corrections: Array<{ symbol: string }>;
    };
    market = report.market;
    files = report.corrections.map(c => `${c.symbol}.json`);
    console.log(`\n📤 從修正報告同步 ${files.length} 個 ${market} 檔案到 Blob`);
  } else if (MARKET && ALL) {
    // 上傳整個市場
    market = MARKET as 'TW' | 'CN';
    const dir = path.join(process.cwd(), 'data', 'candles', market);
    files = (await readdir(dir)).filter(f => f.endsWith('.json'));
    console.log(`\n📤 全量同步 ${files.length} 個 ${market} 檔案到 Blob`);
  } else {
    console.error('❌ 請用 --report 指定修正報告 或 --market TW/CN --all 全量同步');
    process.exit(1);
  }

  const dataDir = path.join(process.cwd(), 'data', 'candles', market);
  let ok = 0;
  let fail = 0;
  const startTime = Date.now();

  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const content = await readFile(path.join(dataDir, file), 'utf-8');
        await put(`candles/${market}/${file}`, content, {
          access: 'private' as const,
          addRandomSuffix: false,
        });
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled') ok++;
      else {
        fail++;
        console.error('  ❌', (r.reason as Error)?.message);
      }
    }

    const done = i + batch.length;
    if (done % 50 === 0 || done === files.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  [${done}/${files.length}] ok=${ok} fail=${fail} | ${elapsed}s`);
    }

    await sleep(500);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ Blob 同步完成（${elapsed}s）`);
  console.log(`   成功: ${ok}`);
  console.log(`   失敗: ${fail}`);
}

main().catch(err => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
