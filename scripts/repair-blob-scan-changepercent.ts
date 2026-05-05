/**
 * 修 Blob 上 scan 檔的 changePercent stale 值。
 * 來源：data/_blob-scan-stale-report-v2.json
 * 修法：對每個 mismatch，把 changePercent 改成 expected，其他欄位完全不動。
 *      寫回 Blob 同 path。
 *
 * 用法:
 *   export $(grep -v '^#' .env.local | xargs)
 *   npx tsx scripts/repair-blob-scan-changepercent.ts            # 預設 dry-run
 *   npx tsx scripts/repair-blob-scan-changepercent.ts --apply    # 實際寫入
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import { list, put as blobPut } from '@vercel/blob';

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN!;
if (!TOKEN) { console.error('需要 BLOB_READ_WRITE_TOKEN'); process.exit(1); }

const APPLY = process.argv.includes('--apply');

interface StaleEntry {
  blobPath: string;
  market: string;
  date: string;
  totalResults: number;
  mismatches: Array<{ symbol: string; blob: number; expected: number }>;
}

async function findBlobUrl(blobPath: string): Promise<string | null> {
  const r = await list({ token: TOKEN, prefix: blobPath, limit: 5 });
  const exact = r.blobs.find(b => b.pathname === blobPath);
  return exact?.url ?? null;
}

async function main() {
  const stale: StaleEntry[] = JSON.parse(await fs.readFile('data/_blob-scan-stale-report-v2.json', 'utf8'));
  console.log(`📋 ${stale.length} 個 stale scan 檔，共 ${stale.reduce((n, e) => n + e.mismatches.length, 0)} 筆 changePercent 修正`);
  console.log(APPLY ? '✏️  APPLY 模式：實際寫入 Blob' : '🔍 DRY-RUN 模式：只列計畫，不寫入');
  console.log();

  let okCnt = 0, failCnt = 0, fixedRows = 0;
  for (const entry of stale) {
    const url = await findBlobUrl(entry.blobPath);
    if (!url) { console.warn(`  ❌ 找不到 ${entry.blobPath}`); failCnt++; continue; }

    const json = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } }).then(r => r.json()) as {
      results: Array<{ symbol: string; changePercent: number; [k: string]: unknown }>;
      [k: string]: unknown;
    };

    const expectedMap = new Map(entry.mismatches.map(m => [m.symbol, m.expected]));
    let modifiedHere = 0;
    for (const r of json.results) {
      const exp = expectedMap.get(r.symbol);
      if (exp != null && Math.abs(r.changePercent - exp) > 0.5) {
        r.changePercent = Number(exp.toFixed(4));
        modifiedHere++;
      }
    }

    if (modifiedHere === 0) { console.log(`  ⚪ ${entry.blobPath} 無需修（已對齊）`); continue; }

    if (APPLY) {
      try {
        await blobPut(entry.blobPath, JSON.stringify(json), {
          access: 'private' as 'public',
          token: TOKEN,
          contentType: 'application/json',
          addRandomSuffix: false,
          allowOverwrite: true,
        });
        okCnt++; fixedRows += modifiedHere;
        console.log(`  ✅ ${entry.blobPath}  修了 ${modifiedHere} 筆`);
      } catch (e) {
        failCnt++;
        console.warn(`  ❌ ${entry.blobPath}`, e instanceof Error ? e.message : e);
      }
    } else {
      okCnt++; fixedRows += modifiedHere;
      console.log(`  📝 ${entry.blobPath}  將修 ${modifiedHere} 筆`);
    }
  }

  console.log(`\n✅ 完成: ${okCnt} 個檔 / ${fixedRows} 筆 row 修正, ${failCnt} 失敗`);
  if (!APPLY) console.log('   下次加 --apply 實際寫入');
}

main().catch(e => { console.error(e); process.exit(1); });
