/**
 * normalize-cn-l1-volume.ts
 *
 * 問題根源：CN L1 歷史有些股票用「手」存、有些用「股」存，單位混亂。
 * 每次從 EastMoney/Tencent 寫入新 K 棒（轉成「股」後），就跟舊「手」歷史對不上。
 *
 * 解法：
 * 1. 以今天（04-22）剛從 L2 寫入的 K 棒（確定是「股」）為基準
 * 2. 計算 today_volume / prev_volume 的比值
 * 3. 比值 > 50 → 歷史是「手」→ 把除了今天以外的所有 K 棒 ×100
 * 4. 修完後所有 K 棒都是「股」，以後寫入也只用「股」
 *
 * 用法：
 *   npx tsx scripts/normalize-cn-l1-volume.ts             # 實際修改
 *   npx tsx scripts/normalize-cn-l1-volume.ts --dry-run   # 只列出不修改
 */

import { config } from 'dotenv';
import { existsSync, readdirSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import path from 'path';
import { readFile, writeFile } from 'fs/promises';

const L1_DIR = path.join(process.cwd(), 'data', 'candles', 'CN');
const DRY_RUN = process.argv.includes('--dry-run');

// 今天從 L2 append 進去的日期（確定是「股」單位）
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
// 比值門檻：今日量 / 前日量 > 50 → 前日是「手」
const RATIO_THRESHOLD = 50;
// 前日量太小的股票跳過（可能是停牌）
const MIN_PREV_VOL = 100;

interface RawCandle { date: string; volume: number; [k: string]: unknown; }
interface CandleFile { candles: RawCandle[]; lastDate?: string; [k: string]: unknown; }

interface Result {
  symbol: string;
  action: 'normalized' | 'already_ok' | 'no_today_bar' | 'skipped_low_vol' | 'error';
  ratio?: number;
  count?: number;
}

async function processFile(filePath: string): Promise<Result> {
  const symbol = path.basename(filePath, '.json');
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf-8')) as CandleFile;
    const candles = raw.candles ?? [];
    if (candles.length < 2) return { symbol, action: 'skipped_low_vol' };

    const todayIdx = candles.findIndex(c => c.date === TODAY);
    if (todayIdx < 0) return { symbol, action: 'no_today_bar' };

    // 找今天前最近一根非零 K 棒
    let prevIdx = todayIdx - 1;
    while (prevIdx >= 0 && candles[prevIdx].volume <= 0) prevIdx--;
    if (prevIdx < 0) return { symbol, action: 'skipped_low_vol' };

    const todayVol = candles[todayIdx].volume;
    const prevVol = candles[prevIdx].volume;

    if (prevVol < MIN_PREV_VOL) return { symbol, action: 'skipped_low_vol' };
    if (todayVol <= 0) return { symbol, action: 'skipped_low_vol' };

    const ratio = todayVol / prevVol;
    if (ratio <= RATIO_THRESHOLD) return { symbol, action: 'already_ok', ratio };

    // 歷史是「手」→ 把今天以外的所有 K 棒 ×100
    let count = 0;
    const fixed = candles.map((c, i) => {
      if (i === todayIdx) return c; // 今天已是「股」，不動
      if (c.volume > 0) { count++; return { ...c, volume: Math.round(c.volume * 100) }; }
      return c;
    });

    if (!DRY_RUN) {
      raw.candles = fixed;
      await writeFile(filePath, JSON.stringify(raw), 'utf-8');
    }

    return { symbol, action: 'normalized', ratio, count };
  } catch (err) {
    return { symbol, action: 'error', count: 0 };
  }
}

async function main() {
  const files = readdirSync(L1_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(L1_DIR, f));

  console.log(`掃描 ${files.length} 個 CN L1 檔案 (基準日=${TODAY}, ${DRY_RUN ? 'DRY RUN' : '修改模式'})...\n`);

  let normalized = 0, alreadyOk = 0, noToday = 0, skipped = 0, errors = 0;

  const BATCH = 100;
  for (let i = 0; i < files.length; i += BATCH) {
    const results = await Promise.all(files.slice(i, i + BATCH).map(processFile));
    for (const r of results) {
      switch (r.action) {
        case 'normalized':
          normalized++;
          if (DRY_RUN) console.log(`  [DRY] ${r.symbol}: ratio=${r.ratio?.toFixed(0)}x → ×100 前 ${r.count} 根`);
          break;
        case 'already_ok': alreadyOk++; break;
        case 'no_today_bar': noToday++; break;
        case 'skipped_low_vol': skipped++; break;
        case 'error': errors++; break;
      }
    }
  }

  console.log(`\n完成！`);
  console.log(`  修正（手→股 ×100）：${normalized} 檔`);
  console.log(`  已是股（不需修）：  ${alreadyOk} 檔`);
  console.log(`  無今日 K 棒：       ${noToday} 檔`);
  console.log(`  跳過（量太小）：    ${skipped} 檔`);
  console.log(`  錯誤：              ${errors} 檔`);

  if (!DRY_RUN && normalized > 0) {
    console.log(`\n✅ 所有 CN L1 已統一為「股」單位。往後寫入請確保也用「股」。`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
