/**
 * Daily cron：抓 TWSE 三大法人買賣超
 * 收盤後 15:30 CST (UTC 07:30) 資料公開後觸發
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { fetchTWSEInstitutional } from '@/lib/datasource/TWSEInstitutional';
import { saveInstitutionalTW, readInstitutionalTW } from '@/lib/storage/institutionalStorage';
import { checkCronAuth } from '@/lib/api/cronAuth';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam ?? getLastTradingDay('TW');

  if (!isTradingDay(date, 'TW')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  // 避免重複抓
  const existing = await readInstitutionalTW(date);
  if (existing && existing.length > 0 && !dateParam) {
    return apiOk({ skipped: true, reason: 'already cached', date, count: existing.length });
  }

  try {
    const records = await fetchTWSEInstitutional(date);
    if (records.length === 0) {
      return apiOk({ skipped: true, reason: 'empty response (non-trading or not yet published)', date });
    }
    await saveInstitutionalTW(date, records);
    return apiOk({ date, count: records.length });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err), 500);
  }
}
