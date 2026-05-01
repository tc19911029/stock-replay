/**
 * 把 replay 修好的歷史 scan 檔同步到 Vercel Blob
 *
 * 本地檔名: scan-{market}-{direction}-{mtfMode}-{date}.json
 * Blob key:  scans/{market}/{direction}/{mtfMode}/{date}.json
 *
 * 用法:
 *   npx tsx scripts/sync-replayed-scans-to-blob.ts          # 同步最近 6h 改過的
 *   npx tsx scripts/sync-replayed-scans-to-blob.ts 24       # 同步最近 24h 改過的
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

interface ParsedName {
  market: string;
  direction: string;
  mtfMode: string;
  date: string;
}

/**
 * scan-TW-long-daily-2026-04-21.json → {market: TW, direction: long, mtfMode: daily, date: 2026-04-21}
 * scan-TW-long-B-2026-04-21.json → {market: TW, direction: long, mtfMode: B, date: 2026-04-21}
 * 排除 -intraday- 變體
 */
function parseScanFilename(filename: string): ParsedName | null {
  if (!filename.startsWith('scan-')) return null;
  if (filename.includes('-intraday-')) return null; // 不同步盤中
  const base = filename.replace(/^scan-/, '').replace(/\.json$/, '');
  // 期望格式: {market}-{direction}-{mtfMode}-{YYYY-MM-DD}
  const m = base.match(/^([A-Z]+)-(long|short)-([A-Za-z]+)-(\d{4}-\d{2}-\d{2})$/);
  if (!m) return null;
  return { market: m[1], direction: m[2], mtfMode: m[3], date: m[4] };
}

async function main() {
  const dir = 'data';
  const files = await fs.readdir(dir);
  const cutoff = Date.now() - RECENT_HOURS * 3600_000;

  const targets: Array<{ filename: string; parsed: ParsedName }> = [];
  for (const f of files) {
    if (!f.startsWith('scan-')) continue;
    const parsed = parseScanFilename(f);
    if (!parsed) continue;
    const stat = await fs.stat(path.join(dir, f));
    if (stat.mtimeMs < cutoff) continue;
    targets.push({ filename: f, parsed });
  }

  console.log(`📤 找到 ${targets.length} 個 ≤${RECENT_HOURS}h mtime 的 scan 檔要推上 Blob`);

  let ok = 0, fail = 0;
  for (const { filename, parsed } of targets) {
    const json = await fs.readFile(path.join(dir, filename), 'utf8');
    const blobKey = `scans/${parsed.market}/${parsed.direction}/${parsed.mtfMode}/${parsed.date}.json`;
    try {
      await blobPut(blobKey, json, {
        access: 'private' as 'public',
        token: TOKEN,
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      ok++;
      if (ok % 20 === 0) process.stdout.write(`\r   推送進度 ${ok}/${targets.length}`);
    } catch (e) {
      fail++;
      console.warn(`\n  fail ${blobKey}:`, e instanceof Error ? e.message.slice(0, 100) : e);
    }
  }
  console.log(`\n✅ 完成: ok=${ok} fail=${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
