import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { loadScanSession } from '@/lib/storage/scanStorage';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { runScanPipeline } from '@/lib/scanner/ScanPipeline';

export const runtime = 'nodejs';
export const maxDuration = 300;

type MarketType = 'TW' | 'CN';

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const market = req.nextUrl.searchParams.get('market') as MarketType | null;
  if (market !== 'TW' && market !== 'CN') {
    return apiError('market must be TW or CN', 400);
  }

  const date = getLastTradingDay(market);
  if (!isTradingDay(date, market)) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  // 已有結果則跳過
  const existing = await loadScanSession(market, date, 'long', 'daily');
  if (existing && existing.resultCount > 0) {
    return apiOk({ skipped: true, reason: 'scan already has results', date, resultCount: existing.resultCount });
  }

  console.warn(`[retry-scan] ${market} ${date} long-daily resultCount=${existing?.resultCount ?? 'missing'}, 重新掃描`);

  try {
    const result = await runScanPipeline({
      market,
      date,
      sessionType: 'post_close',
      directions: ['long', 'short'],
      mtfModes: ['daily', 'mtf'],
      force: true,
    });

    return apiOk({ retried: true, ...result });
  } catch (err) {
    console.error('[retry-scan] error:', err);
    return apiError(String(err));
  }
}
