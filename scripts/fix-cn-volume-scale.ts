/**
 * fix-cn-volume-scale.ts
 *
 * 修復 CN L1 中因 EastMoney/Tencent 回傳單位為「手」而非「股」
 * 導致特定日期的成交量縮小 100 倍的問題。
 *
 * 判斷邏輯：若某一根 K 棒的量 < 前一根的 5%（且前一根 > 10000），
 * 視為單位錯誤，乘以 100 修正。
 *
 * 用法：
 *   npx tsx scripts/fix-cn-volume-scale.ts
 *   npx tsx scripts/fix-cn-volume-scale.ts --dry-run   # 只列出不修改
 */

import { config } from 'dotenv';
import { existsSync, readdirSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import path from 'path';
import { readFile, writeFile } from 'fs/promises';

const DATA_DIR = path.join(process.cwd(), 'data', 'candles', 'CN');
const DRY_RUN = process.argv.includes('--dry-run');
const RATIO_THRESHOLD = 0.05; // < 5% of prev day = likely unit mismatch
const MIN_PREV_VOL = 10_000;   // 前一根至少 10000 才做判定

interface RawCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  [key: string]: unknown;
}

interface CandleFile {
  candles: RawCandle[];
  lastDate: string;
  [key: string]: unknown;
}

async function fixFile(filePath: string): Promise<{ fixed: number; symbol: string }> {
  const raw = await readFile(filePath, 'utf-8');
  const data: CandleFile = JSON.parse(raw);
  const candles = data.candles;
  if (!candles || candles.length < 2) return { fixed: 0, symbol: path.basename(filePath) };

  let fixed = 0;

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    // Only look at recent dates (from 2026-04-01 onwards to avoid touching old data)
    if (cur.date < '2026-04-01') continue;

    const prevVol = prev.volume;
    const curVol = cur.volume;

    if (
      prevVol >= MIN_PREV_VOL &&
      curVol > 0 &&
      curVol < prevVol * RATIO_THRESHOLD
    ) {
      fixed++;
      if (!DRY_RUN) {
        candles[i] = { ...cur, volume: Math.round(curVol * 100) };
      } else {
        console.log(`  [DRY] ${path.basename(filePath)} ${cur.date}: vol ${curVol} → ${curVol * 100} (prev=${prevVol})`);
      }
    }
  }

  if (fixed > 0 && !DRY_RUN) {
    data.candles = candles;
    await writeFile(filePath, JSON.stringify(data), 'utf-8');
  }

  return { fixed, symbol: path.basename(filePath, '.json') };
}

async function main() {
  const files = readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(DATA_DIR, f));

  console.log(`掃描 ${files.length} 個 CN L1 檔案 (${DRY_RUN ? 'DRY RUN' : '修改模式'})...`);

  let totalFixed = 0;
  let totalFiles = 0;

  const CONCURRENCY = 50;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(fixFile));
    for (const r of results) {
      if (r.fixed > 0) {
        totalFiles++;
        totalFixed += r.fixed;
        if (!DRY_RUN) console.log(`  ✅ ${r.symbol}: ${r.fixed} 根修正`);
      }
    }
    if ((i / CONCURRENCY) % 20 === 0) {
      console.log(`  ... ${Math.min(i + CONCURRENCY, files.length)}/${files.length}`);
    }
  }

  console.log(`\n完成！修正 ${totalFiles} 檔 / ${totalFixed} 根 K 棒`);
}

main().catch(e => { console.error(e); process.exit(1); });
