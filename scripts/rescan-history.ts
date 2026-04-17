/**
 * 重跑過去 N 個交易日的 L4 掃描，套用新閾值（ZHU_OPTIMIZED）
 *
 * 之前 L4 用 ZHU_V1（寬鬆）掃出來，換成 ZHU_OPTIMIZED（嚴格）後歷史結果不一致。
 * 這個腳本用 runScanPipeline 以 force=true 重跑每一個日期。
 *
 * 用法：
 *   npx tsx scripts/rescan-history.ts
 *   npx tsx scripts/rescan-history.ts --market TW
 *   npx tsx scripts/rescan-history.ts --days 20
 */

import { config } from 'dotenv';
import { existsSync, readdirSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { runScanPipeline } from '../lib/scanner/ScanPipeline';
import { isTradingDay } from '../lib/utils/tradingDay';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

// 從 L4 檔名收集現存日期
function listExistingDates(market: 'TW' | 'CN'): string[] {
  const dates = new Set<string>();
  try {
    const entries = readdirSync(DATA_DIR);
    for (const name of entries) {
      const m = name.match(new RegExp(`^scan-${market}-\\w+-\\w+-(\\d{4}-\\d{2}-\\d{2})\\.json$`));
      if (m) dates.add(m[1]);
    }
  } catch { /* empty */ }
  return [...dates].sort();
}

async function main() {
  const args = process.argv.slice(2);
  const markets: ('TW' | 'CN')[] = [];
  let maxDays = 30;
  let onlyDate: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--market' && args[i + 1]) {
      const m = args[i + 1].toUpperCase();
      if (m === 'TW' || m === 'CN') markets.push(m as 'TW' | 'CN');
      i++;
    } else if (args[i] === '--days' && args[i + 1]) {
      maxDays = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--date' && args[i + 1]) {
      onlyDate = args[i + 1];
      i++;
    }
  }

  const targetMarkets: ('TW' | 'CN')[] = markets.length > 0 ? markets : ['TW', 'CN'];

  console.log(`\n🔄 重跑歷史 L4 掃描 — ${new Date().toISOString()}`);
  console.log(`   市場: ${targetMarkets.join(', ')}, 最多 ${maxDays} 天`);

  for (const market of targetMarkets) {
    let dates = listExistingDates(market).slice(-maxDays);
    if (onlyDate) dates = dates.filter(d => d === onlyDate);
    console.log(`\n📅 [${market}] 找到 ${dates.length} 個日期: ${dates[0] ?? 'n/a'} ~ ${dates[dates.length - 1] ?? 'n/a'}`);

    for (const date of dates) {
      if (!isTradingDay(date, market)) {
        console.log(`   ⏭️  ${date} 非交易日，跳過`);
        continue;
      }

      console.log(`\n🔍 [${market} ${date}] 重跑掃描...`);
      try {
        const result = await runScanPipeline({
          market,
          date,
          sessionType: 'post_close',
          directions: ['long', 'short'],
          mtfModes: ['daily', 'mtf'],
          force: true,
          deadlineMs: 600_000,
        });
        const summary = Object.entries(result.counts).map(([k, v]) => `${k}=${v}`).join(' ');
        console.log(`   ✅ ${summary}`);
      } catch (err) {
        console.error(`   ❌ 失敗:`, err instanceof Error ? err.message : err);
      }
    }
  }

  console.log(`\n🎉 重跑完成`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
