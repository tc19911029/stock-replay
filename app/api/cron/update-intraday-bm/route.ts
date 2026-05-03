// GET /api/cron/update-intraday-bm?market=TW|CN&method=B|C|D|E|F|G|H|I
//
// 盤中買法掃描（B/C/D/E/F/G/H/I 各自獨立 cron，錯開觸發）
//
// 跟 update-intraday 分工：
//   - update-intraday：每 5 分鐘刷新 L2 + 跑 A 六條件
//   - update-intraday-bm：不刷新 L2（讀現成快照），只跑指定買法一支
//
// 這樣每 cron tick 只做 1 策略 × 1956 支 ≈ 20–40s，絕對撐得過 maxDuration=120s。

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { readIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { isMarketOpen, isPostCloseWindow, getCurrentTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';

export const runtime = 'nodejs';
export const maxDuration = 120;

const VALID_METHODS = new Set(['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as 'TW' | 'CN';
  const method = req.nextUrl.searchParams.get('method') as 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | null;

  if (!method || !VALID_METHODS.has(method)) {
    return apiError(`method required (B|C|D|E|F|G|H|I), got: ${method}`, 400);
  }

  if (!isMarketOpen(market) && !isPostCloseWindow(market)) {
    return apiOk({ skipped: true, reason: `${market} 非開盤時段也非盤後窗口`, market, method });
  }

  const date = getCurrentTradingDay(market);
  if (!isTradingDay(date, market)) {
    return apiOk({ skipped: true, reason: `${date} 非交易日`, market, method, date });
  }

  // 讀現成 L2（不刷新 — A cron 每 5 分鐘已刷新）
  const snapshot = await readIntradaySnapshot(market, date);
  if (!snapshot || snapshot.count === 0) {
    return apiOk({
      skipped: true,
      reason: `L2 快照不存在或為空（等 update-intraday 先刷）`,
      market, method, date,
    });
  }

  const realtimeQuotes = new Map<string, {
    open: number; high: number; low: number; close: number; volume: number; date?: string;
  }>();
  for (const q of snapshot.quotes) {
    const code = q.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    if (q.close > 0) {
      realtimeQuotes.set(code, {
        open: q.open, high: q.high, low: q.low,
        close: q.close, volume: q.volume,
        date: snapshot.date,
      });
    }
  }

  try {
    const { saveScanSession } = await import('@/lib/storage/scanStorage');
    const { readTurnoverRank } = await import('@/lib/scanner/TurnoverRank');
    const scanner = market === 'TW'
      ? new (await import('@/lib/scanner/TaiwanScanner')).TaiwanScanner()
      : new (await import('@/lib/scanner/ChinaScanner')).ChinaScanner();

    scanner.setRealtimeQuotes(realtimeQuotes);
    const stocks = await scanner.getStockList();
    const bmResults = await scanner.scanBuyMethod(method, stocks, date);

    // 注入成交額排名（BCDEF 不做 top500 過濾，只拿排名當顯示 tag）
    try {
      const rank = await readTurnoverRank(market);
      if (rank) {
        for (const r of bmResults) {
          const n = rank.ranks.get(r.symbol);
          if (n) r.turnoverRank = n;
        }
      }
    } catch (err) {
      console.warn(`[cron/update-intraday-bm] ${market} ${method} TurnoverRank 讀取失敗（繼續）:`, err);
    }

    // 注入 marketTrend（與 scan-bm 一致，供 UI 顯示）
    let marketTrend: string | undefined;
    try {
      const trend = await scanner.getMarketTrend(date);
      marketTrend = String(trend);
    } catch { /* non-critical */ }

    const session = {
      id: `${market}-long-${method}-${date}-intraday-${Date.now()}`,
      market,
      date,
      direction: 'long' as const,
      multiTimeframeEnabled: false,
      sessionType: 'intraday' as const,
      scanTime: new Date().toISOString(),
      resultCount: bmResults.length,
      results: bmResults,
      marketTrend,
      buyMethod: method as 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I',
    };
    await saveScanSession(session);

    return apiOk({
      market, method, date,
      l2Count: snapshot.count,
      resultCount: bmResults.length,
      l2UpdatedAt: snapshot.updatedAt,
    });
  } catch (err) {
    console.error(`[cron/update-intraday-bm] ${market} ${method} 掃描失敗:`, err);
    return apiError(`${market} ${method} scan failed: ${String(err)}`);
  }
}
