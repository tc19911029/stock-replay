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
  const date = dateParam ?? getLastTradingDay('CN');

  if (!isTradingDay(date, 'CN')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  // 支援批次分割（Vercel 300s 限制）
  const batch = parseInt(req.nextUrl.searchParams.get('batch') ?? '0', 10) || undefined;
  const totalBatches = parseInt(req.nextUrl.searchParams.get('totalBatches') ?? '0', 10) || undefined;

  try {
    const result = await runScanPipeline({
      market: 'CN',
      date,
      sessionType: 'post_close',
      directions: ['long', 'short'],
      mtfModes: ['daily', 'mtf'],
      buyMethods: ['E', 'B', 'C', 'D'],
      force: true,
      batch,
      totalBatches,
    });

    const alert = (result.counts['long-daily'] ?? 0) === 0;
    if (alert) {
      console.warn(`[cron/scan-cn] ★ 交易日 ${date} long-daily 0 筆`);
    }

    return apiOk({
      ...result,
      ...(alert && { alert: true, warning: `交易日 ${date} long-daily 0 筆` }),
    });
  } catch (err) {
    return apiError(String(err));
  }
}
