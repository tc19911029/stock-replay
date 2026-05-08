/**
 * 把 data/lock-watch/{TW|CN}/{date}.json 同步到 Vercel Blob
 *
 * Blob key: lock-watch/{market}/{date}.json
 *
 * 用法:
 *   npx tsx scripts/sync-lockwatch-to-blob.ts          # 全部
 *   npx tsx scripts/sync-lockwatch-to-blob.ts 24       # 最近 24h
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { put as blobPut } from '@vercel/blob';

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
if (!TOKEN) { console.error('需要 BLOB_READ_WRITE_TOKEN'); process.exit(1); }

const RECENT_HOURS = parseFloat(process.argv[2] ?? '0');  // 0 = 全部

async function main() {
  const root = path.join('data', 'lock-watch');
  let totalOk = 0, totalFail = 0;
  for (const market of ['TW', 'CN'] as const) {
    const dir = path.join(root, market);
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    } catch {
      console.log(`  ${market}: 沒有 lock-watch 目錄，skip`);
      continue;
    }
    if (RECENT_HOURS > 0) {
      const cutoff = Date.now() - RECENT_HOURS * 3600_000;
      const filtered: string[] = [];
      for (const f of files) {
        const stat = await fs.stat(path.join(dir, f));
        if (stat.mtimeMs >= cutoff) filtered.push(f);
      }
      files = filtered;
    }
    console.log(`📤 ${market}: ${files.length} 個 lock-watch 檔要推上 Blob`);
    let ok = 0, fail = 0;
    for (const f of files) {
      const json = await fs.readFile(path.join(dir, f), 'utf-8');
      const date = f.replace(/\.json$/, '');
      const key = `lock-watch/${market}/${date}.json`;
      try {
        await blobPut(key, json, { access: 'private' as 'public', token: TOKEN, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
        ok++;
      } catch (err) {
        fail++;
        console.error(`  ✗ ${key}: ${err}`);
      }
    }
    console.log(`  ${market} 完成: ok=${ok} fail=${fail}`);
    totalOk += ok; totalFail += fail;
  }
  console.log(`\n✅ 總計: ok=${totalOk} fail=${totalFail}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
