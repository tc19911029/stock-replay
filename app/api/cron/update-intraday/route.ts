// GET /api/cron/update-intraday — 盤中 L2 快照刷新（只做刷新，不掃描）
//
// 由 Vercel Cron 每 5 分鐘觸發
// - 將全市場即時報價寫入 Layer 2 快照（單一 JSON 檔）
// - L4 掃描改由 scan-intraday route 獨立觸發，避免 route 時間爆掉

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { refreshIntradaySnapshot, getLastRefreshSummary } from '@/lib/datasource/IntradayCache';
import { isMarketOpen, isPostCloseWindow, getCurrentTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';

export const runtime = 'nodejs';
export const maxDuration = 30; // L2 刷新只需 < 10s

export async function GET(req: NextRequest) {
  // Verify Vercel cron secret
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as 'TW' | 'CN';

  // 盤中 + 盤後窗口（TW 13:31~14:30 / CN 15:01~15:30）都跑：
  // 收盤後還需要一輪來抓最終收盤資料 + 跑盤後掃描，對齊 instrumentation.ts 的條件
  if (!isMarketOpen(market) && !isPostCloseWindow(market)) {
    return apiOk({ skipped: true, reason: `${market} 非開盤時段也非盤後窗口`, market });
  }

  try {
    const snapshot = await refreshIntradaySnapshot(market);
    const date = getCurrentTradingDay(market);
    const summary = getLastRefreshSummary(market);

    if (snapshot.count === 0 && isTradingDay(date, market)) {
      console.error(
        `[cron/update-intraday] ★★ ${market} L2 刷新為空！` +
        `連續空 ${summary.consecutiveEmptyCount} 次，告警: ${summary.alertLevel}`
      );
      return apiOk({
        market,
        date: snapshot.date,
        count: 0,
        updatedAt: snapshot.updatedAt,
        alert: true,
        alertLevel: summary.alertLevel,
        warning: `交易日 ${date} 所有數據源失敗`,
        dataSourceStatus: summary.sources,
      });
    }

    return apiOk({
      market,
      date: snapshot.date,
      count: snapshot.count,
      updatedAt: snapshot.updatedAt,
      dataSourceStatus: summary.sources,
      alertLevel: summary.alertLevel,
    });
  } catch (err) {
    console.error(`[cron/update-intraday] ${market} error:`, err);
    return apiError(`${market} 盤中快照更新失敗: ${String(err)}`);
  }
}
