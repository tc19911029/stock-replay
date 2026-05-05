/**
 * Cron: 抓 TDCC 集保戶股權分散表（每週四晚上 18:00 公布上週五持股）
 *
 * 排程：每週四 18:30 CST（= 週四 10:30 UTC）
 *   `30 10 * * 4`
 *
 * Vercel cron 必填回傳格式：apiOk + 200
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { fetchTdccLatestWeek } from '@/lib/datasource/TdccProvider';
import { appendTdccDay, readTdccStock } from '@/lib/chips/ChipStorage';
import { checkCronAuth } from '@/lib/api/cronAuth';

export const runtime = 'nodejs';
export const maxDuration = 300; // TDCC CSV 約 2.3 MB，需較長 timeout

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  try {
    console.log('[cron/fetch-tdcc-week] 開始抓取 TDCC 集保資料...');
    const week = await fetchTdccLatestWeek();
    console.log(`[cron/fetch-tdcc-week] 取得 ${week.date}，共 ${week.data.size} 檔`);

    let saved = 0;
    let skipped = 0;
    for (const [code, row] of week.data) {
      const existing = await readTdccStock(code);
      if (existing?.lastDate === week.date) {
        skipped++;
        continue;
      }
      await appendTdccDay(code, week.date, row);
      saved++;
    }

    console.log(`[cron/fetch-tdcc-week] 完成 saved=${saved} skipped=${skipped}`);
    return apiOk({
      date: week.date,
      totalStocks: week.data.size,
      saved,
      skipped,
    });
  } catch (err) {
    console.error('[cron/fetch-tdcc-week] 失敗:', err);
    return apiError(err instanceof Error ? err.message : 'TDCC fetch failed');
  }
}
