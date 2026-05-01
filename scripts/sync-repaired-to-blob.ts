/**
 * 把本地最近修復的 L1 檔案同步到 Vercel Blob (production)
 *
 * Blob key 格式（與 production read path 一致）：
 *   candles/{market}/{symbol}.json
 *
 * 用法：
 *   npx tsx scripts/sync-repaired-to-blob.ts          # 同步最近 6 小時改過的
 *   npx tsx scripts/sync-repaired-to-blob.ts 24       # 同步最近 24 小時改過的
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

const RECENT_HOURS = parseFloat(process.argv[2] ?? '6');
const CONCURRENCY = 8;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function syncMarket(market: 'TW' | 'CN'): Promise<void> {
  const dir = path.join('data', 'candles', market);
  const files = await fs.readdir(dir);
  const cutoff = Date.now() - RECENT_HOURS * 3600_000;
  const targets: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const stat = await fs.stat(path.join(dir, f));
    if (stat.mtimeMs >= cutoff) targets.push(f);
  }
  console.log(`📤 ${market}: ${targets.length} 檔要推上 Blob (mtime < ${RECENT_HOURS}h)`);

  let ok = 0, fail = 0;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async (f) => {
      const symbol = f.replace('.json', '');
      const json = await fs.readFile(path.join(dir, f), 'utf8');
      const key = `candles/${market}/${symbol}.json`; // 對齊 CandleStorageAdapter blobKey
      try {
        await blobPut(key, json, {
          access: 'private' as 'public',
          token: TOKEN,
          contentType: 'application/json',
          addRandomSuffix: false,
          allowOverwrite: true,
        });
        ok++;
      } catch (e) {
        fail++;
        if (fail <= 3) console.warn(`  fail ${symbol}:`, e instanceof Error ? e.message.slice(0, 100) : e);
      }
    }));
    if (i % (CONCURRENCY * 10) === 0) {
      const pct = Math.min(100, Math.round((i + CONCURRENCY) / targets.length * 100));
      process.stdout.write(`\r   ${market} ${pct}% ok=${ok} fail=${fail}`);
    }
    await sleep(120);
  }
  console.log(`\n   ${market} 完成: ok=${ok} fail=${fail}`);
}

async function main() {
  await syncMarket('TW');
  await syncMarket('CN');
}

main().catch(e => { console.error(e); process.exit(1); });
