import { NextRequest } from 'next/server';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { ScanSession, MarketId } from '@/lib/scanner/types';
import { saveScanSession } from '@/lib/storage/scanStorage';
import { apiOk, apiError } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { isMarketOpen, getCurrentTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * 盤中掃描 cron — 在開盤期間定時跑粗掃+精掃，存為 intraday session。
 *
 * 用法：/api/cron/scan-intraday?market=TW 或 ?market=CN
 * 排程：
 *   TW: 10 1,2,3,4,5 * * 1-5  (09:10, 10:10, 11:10, 12:10, 13:10 CST)
 *   CN: 40 1,3,5,7 * * 1-5    (09:40, 11:40, 13:40, 15:40 CST)
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as MarketId;
  if (market !== 'TW' && market !== 'CN') {
    return apiError('Invalid market, must be TW or CN');
  }

  try {
    const date = getCurrentTradingDay(market);

    if (!isTradingDay(date, market)) {
      return apiOk({ skipped: true, reason: 'non-trading day', date, market });
    }

    // 非開盤時間不跑（cron 可能因 timezone 差異意外觸發）
    if (!isMarketOpen(market)) {
      return apiOk({ skipped: true, reason: 'market not open', date, market });
    }

    const scanner = market === 'TW' ? new TaiwanScanner() : new ChinaScanner();
    const stocks = await scanner.getStockList();

    // 只跑 long daily（盤中最常用，精簡掃描時間）
    const { results, marketTrend, sessionFreshness } = await scanner.scanSOP(stocks, date);
    const session: ScanSession = {
      id: `${market}-long-daily-intraday-${date}-${Date.now()}`,
      market,
      date,
      direction: 'long',
      multiTimeframeEnabled: false,
      sessionType: 'intraday',
      scanTime: new Date().toISOString(),
      resultCount: results.length,
      results,
      dataFreshness: sessionFreshness,
    };
    await saveScanSession(session);

    return apiOk({
      market,
      date,
      sessionType: 'intraday',
      resultCount: results.length,
      marketTrend,
    });
  } catch (err) {
    console.error(`[scan-intraday] ${market} error:`, err);
    return apiError(String(err));
  }
}
