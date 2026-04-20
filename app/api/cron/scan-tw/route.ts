import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { runScanPipeline } from '@/lib/scanner/ScanPipeline';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam ?? getLastTradingDay('TW');

  if (!isTradingDay(date, 'TW')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  try {
    const result = await runScanPipeline({
      market: 'TW',
      date,
      sessionType: 'post_close',
      directions: ['long', 'short'],
      mtfModes: ['daily', 'mtf'],
      buyMethods: ['E', 'B', 'C', 'D'],
      force: true,
    });

    const alert = (result.counts['long-daily'] ?? 0) === 0;
    if (alert) {
      console.warn(`[cron/scan-tw] ★ 交易日 ${date} long-daily 0 筆`);
    }

    return apiOk({
      ...result,
      ...(alert && { alert: true, warning: `交易日 ${date} long-daily 0 筆` }),
    });
  } catch (err) {
    return apiError(String(err));
  }
}
