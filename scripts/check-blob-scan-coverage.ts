/**
 * 直接從 Vercel Blob 列出 v12 各方法歷史覆蓋率
 *
 * 不打 production API（避免 rate limit）— 直接列 Blob 檔。
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { list } from '@vercel/blob';

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN!;

async function listAll(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const r = await list({ prefix, limit: 100, cursor, token: TOKEN });
    out.push(...r.blobs.map((b) => b.pathname));
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}

async function main() {
  for (const market of ['TW', 'CN'] as const) {
    console.log(`\n=== ${market} v12 各方法覆蓋率 ===`);
    for (const m of ['B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q']) {
      const blobs = await listAll(`scans/${market}/long/${m}/`);
      const dates = blobs.map((p) => p.match(/\/(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter(Boolean).sort();
      console.log(`  ${market}-${m}: ${dates.length} 天 (range ${dates[0] ?? '-'} → ${dates[dates.length - 1] ?? '-'})`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
