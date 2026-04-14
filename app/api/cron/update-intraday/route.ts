// GET /api/cron/update-intraday — 盤中即時快照自動更新 + 掃描
//
// 由 Vercel Cron 每 5 分鐘（TW）/ 2 分鐘（CN）觸發
// 1. 將全市場即時報價寫入 Layer 2 快照（單一 JSON 檔）
// 2. 合併 L1 歷史K線，跑一次 long-daily 掃描策略
// 3. 結果存入 L4（覆蓋同日 post_close，前端免改動）

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { refreshIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { isMarketOpen, getCurrentTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';
export const maxDuration = 120; // 提高：L2 刷新 ~5s + 掃描 ~30-60s

export async function GET(req: NextRequest) {
  // Verify Vercel cron secret
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as 'TW' | 'CN';

  // 只在盤中更新
  if (!isMarketOpen(market)) {
    return apiOk({ skipped: true, reason: `${market} 非開盤時段`, market });
  }

  try {
    // ── Phase 1: 刷新 L2 快照 ──
    const snapshot = await refreshIntradaySnapshot(market);

    // ── Phase 2: 盤中掃描（僅 long-daily，精簡版）──
    const date = getCurrentTradingDay(market);
    let scanCount = -1;

    try {
      const { saveScanSession } = await import('@/lib/storage/scanStorage');

      if (market === 'TW') {
        const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner');
        const scanner = new TaiwanScanner();
        const stocks = await scanner.getStockList();
        const { results, sessionFreshness } = await scanner.scanSOP(stocks, date);

        const session = {
          id: `TW-long-daily-${date}-intraday-${Date.now()}`,
          market: 'TW' as const,
          date,
          direction: 'long' as const,
          multiTimeframeEnabled: false,
          scanTime: new Date().toISOString(),
          resultCount: results.length,
          results,
          dataFreshness: sessionFreshness,
        };
        await saveScanSession(session);
        scanCount = results.length;
      } else {
        const { ChinaScanner } = await import('@/lib/scanner/ChinaScanner');
        const scanner = new ChinaScanner();
        const stocks = await scanner.getStockList();
        const { results, sessionFreshness } = await scanner.scanSOP(stocks, date);

        const session = {
          id: `CN-long-daily-${date}-intraday-${Date.now()}`,
          market: 'CN' as const,
          date,
          direction: 'long' as const,
          multiTimeframeEnabled: false,
          scanTime: new Date().toISOString(),
          resultCount: results.length,
          results,
          dataFreshness: sessionFreshness,
        };
        await saveScanSession(session);
        scanCount = results.length;
      }
    } catch (scanErr) {
      // 掃描失敗不影響 L2 更新結果
      console.error(`[cron/update-intraday] ${market} 盤中掃描失敗 (non-fatal):`, scanErr);
    }

    return apiOk({
      market,
      date: snapshot.date,
      count: snapshot.count,
      updatedAt: snapshot.updatedAt,
      scanCount,
      scanDate: date,
    });
  } catch (err) {
    console.error(`[cron/update-intraday] ${market} error:`, err);
    return apiError(`${market} 盤中快照更新失敗: ${String(err)}`);
  }
}
