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

  // 2026-05-07：?force=1 重抓並比對內容（TDCC 偶爾發修正版同日期不同分布，
  // 原邏輯 lastDate 相同直接跳過會錯過修正）
  const force = req.nextUrl.searchParams.get('force') === '1';

  try {
    console.log('[cron/fetch-tdcc-week] 開始抓取 TDCC 集保資料...');
    const week = await fetchTdccLatestWeek();
    console.log(`[cron/fetch-tdcc-week] 取得 ${week.date}，共 ${week.data.size} 檔`);

    let saved = 0;
    let skipped = 0;
    let updated = 0;
    for (const [code, row] of week.data) {
      const existing = await readTdccStock(code);
      if (existing?.lastDate === week.date && !force) {
        // 同日期且非強制 → 比對 row 簽章決定是否更新
        // 2026-05-08：原寫 existing.rows 但 TdccStockFile schema 是 data 不是 rows（self-bug）
        const lastRow = existing.data?.[existing.data.length - 1];
        const same = lastRow && JSON.stringify(lastRow) === JSON.stringify({ ...row, date: week.date });
        if (same) { skipped++; continue; }
        await appendTdccDay(code, week.date, row);
        updated++;
        continue;
      }
      await appendTdccDay(code, week.date, row);
      saved++;
    }

    console.log(`[cron/fetch-tdcc-week] 完成 saved=${saved} updated=${updated} skipped=${skipped}`);
    return apiOk({
      date: week.date,
      totalStocks: week.data.size,
      saved,
      updated,
      skipped,
    });
  } catch (err) {
    console.error('[cron/fetch-tdcc-week] 失敗:', err);
    return apiError(err instanceof Error ? err.message : 'TDCC fetch failed');
  }
}
