import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { isMarketOpen, getCurrentTradingDay } from '@/lib/datasource/marketHours';
import { runScanPipeline } from '@/lib/scanner/ScanPipeline';
import type { MarketId } from '@/lib/scanner/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as MarketId;
  if (market !== 'TW' && market !== 'CN') {
    return apiError('Invalid market, must be TW or CN');
  }

  const date = getCurrentTradingDay(market);

  if (!isTradingDay(date, market)) {
    return apiOk({ skipped: true, reason: 'non-trading day', date, market });
  }
  if (!isMarketOpen(market) && !req.nextUrl.searchParams.has('force')) {
    return apiOk({ skipped: true, reason: 'market not open', date, market });
  }

  try {
    const result = await runScanPipeline({
      market,
      date,
      sessionType: 'intraday',
      directions: ['long'],
      mtfModes: ['daily'],
    });

    return apiOk({ ...result, sessionType: 'intraday' });
  } catch (err) {
    console.error(`[scan-intraday] ${market} error:`, err);
    return apiError(String(err));
  }
}
