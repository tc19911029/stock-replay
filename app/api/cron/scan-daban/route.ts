import { NextRequest } from 'next/server';
import { scanDabanWithPrefilter } from '@/lib/scanner/DabanScanner';
import { saveDabanSession } from '@/lib/storage/dabanStorage';
import { apiOk, apiError } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  try {
    const { getLastTradingDay } = await import('@/lib/datasource/marketHours');
    const dateParam = req.nextUrl.searchParams.get('date');
    const date = dateParam ?? getLastTradingDay('CN');

    if (!isTradingDay(date, 'CN')) {
      return apiOk({ skipped: true, reason: 'non-trading day', date });
    }

    const session = await scanDabanWithPrefilter(date);

    if (session.resultCount >= 5) {
      await saveDabanSession(session);
      console.log(`[cron/scan-daban] ${date}: ${session.resultCount} 支漲停，已儲存`);
    } else {
      console.warn(`[cron/scan-daban] ${date}: 僅 ${session.resultCount} 支，疑似資料不完整，不儲存`);
    }

    return apiOk({
      date,
      resultCount: session.resultCount,
      sentiment: session.sentiment,
      saved: session.resultCount >= 5,
    });
  } catch (err) {
    return apiError(String(err));
  }
}
