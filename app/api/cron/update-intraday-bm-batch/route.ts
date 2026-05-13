/**
 * GET /api/cron/update-intraday-bm-batch?market=TW|CN&track=bullish|reversal|system
 *
 * 0513 ABCDE E：盤中買法批次掃描，把原本 update-intraday-bm 一字母一 cron
 * 改成一 track 一 cron。同 track 內字母共用 stockList / L2 / TurnoverRank /
 * marketTrend / Step 1 池子，比舊版省 ~5 倍前置時間。
 *
 * 對比 scan-bm-batch（盤後）：
 *   - sessionType='intraday'（不是 post_close）
 *   - 用 isMarketOpen/isPostCloseWindow gate（不只 isTradingDay）
 *   - 不寫 LockWatch（盤中資料未定，lockwatch 一律盤後 commit）
 *   - 用 getCurrentTradingDay 取「正在進行的交易日」(盤中) 而非 getLastTradingDay
 *
 * Track 分流：
 *   - bullish: B/C/E/J/K/L/M/P（多頭軌，要過 Step 1）
 *   - reversal: D/F/N/O（反轉軌，全市場掃）
 *   - system: Q（戰法軌）
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isMarketOpen, isPostCloseWindow, getCurrentTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import {
  BULLISH_TRACK_LETTERS,
  REVERSAL_TRACK_LETTERS,
  SYSTEM_TRACK_LETTERS,
} from '@/lib/scanner/buyMethodTracks';

export const runtime = 'nodejs';
export const maxDuration = 120;

const TRACKS = {
  bullish: BULLISH_TRACK_LETTERS,
  reversal: REVERSAL_TRACK_LETTERS,
  system: SYSTEM_TRACK_LETTERS,
} as const;
type TrackName = keyof typeof TRACKS;

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as 'TW' | 'CN';
  const trackParam = req.nextUrl.searchParams.get('track');
  const force = req.nextUrl.searchParams.get('force') === '1';

  if (!market || !['TW', 'CN'].includes(market)) {
    return apiError('market must be TW or CN', 400);
  }
  if (!trackParam || !(trackParam in TRACKS)) {
    return apiError(`track must be one of ${Object.keys(TRACKS).join(', ')}`, 400);
  }
  const track = trackParam as TrackName;
  const methods = TRACKS[track];

  // 盤中或盤後窗口才跑（除非 force=1）
  if (!force && !isMarketOpen(market) && !isPostCloseWindow(market)) {
    return apiOk({
      skipped: true,
      reason: `${market} 非開盤時段也非盤後窗口`,
      market, track,
    });
  }

  const date = getCurrentTradingDay(market);
  if (!isTradingDay(date, market)) {
    return apiOk({ skipped: true, reason: `${date} 非交易日`, market, track, date });
  }

  const startTime = Date.now();

  try {
    const { saveScanSession } = await import('@/lib/storage/scanStorage');
    const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
    const { readTurnoverRank } = await import('@/lib/scanner/TurnoverRank');
    const { triggerPreload: triggerL1 } = await import('@/lib/datasource/L1CandleCache');
    triggerL1(market);

    let scanner: import('@/lib/scanner/TaiwanScanner').TaiwanScanner | import('@/lib/scanner/ChinaScanner').ChinaScanner;
    if (market === 'CN') {
      const { ChinaScanner } = await import('@/lib/scanner/ChinaScanner');
      scanner = new ChinaScanner();
    } else {
      const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner');
      scanner = new TaiwanScanner();
    }

    // ── L2 inject（盤中必有，沒有就 skip 等 update-intraday 刷新）─────────
    const snap = await readIntradaySnapshot(market, date);
    if (!snap || snap.count === 0) {
      return apiOk({
        skipped: true,
        reason: `L2 快照不存在或為空（等 update-intraday 先刷）`,
        market, track, date,
      });
    }
    const suffix = market === 'TW' ? /\.(TW|TWO)$/i : /\.(SS|SZ)$/i;
    const realtimeQuotes = new Map<string, {
      open: number; high: number; low: number; close: number; volume: number; date?: string;
    }>();
    for (const q of snap.quotes) {
      if (q.close > 0) {
        realtimeQuotes.set(q.symbol.replace(suffix, ''), {
          open: q.open, high: q.high, low: q.low,
          close: q.close, volume: q.volume, date: snap.date,
        });
      }
    }
    scanner.setRealtimeQuotes(realtimeQuotes);

    // ── Stock list + TurnoverRank（共用一次）──────────────────────
    let stocks = await scanner.getStockList();
    let turnoverRanks: Map<string, number> | null = null;
    try {
      const rank = await readTurnoverRank(market);
      if (rank && rank.symbols.size > 0) {
        stocks = stocks.filter(s => rank.symbols.has(s.symbol));
        turnoverRanks = rank.ranks;
      }
    } catch { /* 不致命 */ }

    // ── Market trend（共用一次）──────────────────────────────────
    let marketTrend: string | undefined;
    try {
      const trend = await scanner.getMarketTrend(date);
      marketTrend = String(trend);
    } catch { /* non-critical */ }

    // ── Step 1 池子狀態（盤中：14:02 後才有；'missing' 是常見狀態） ──
    const { loadStep1Pool, deriveStep1FilterState } = await import('@/lib/scanner/step1Pool');
    const step1Pool = await loadStep1Pool(market, date);
    const poolExists = !!step1Pool && step1Pool.symbols.length > 0;

    // ── Sequential per-method scan ─────────────────────────────────
    const summary: Record<string, { count: number; step1Filter: string }> = {};
    for (const m of methods) {
      const method = m as 'B' | 'C' | 'D' | 'E' | 'F' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q';
      const bmResults = await scanner.scanBuyMethod(method, stocks, date);

      if (turnoverRanks) {
        for (const r of bmResults) {
          const rank = turnoverRanks.get(r.symbol);
          if (rank) r.turnoverRank = rank;
        }
      }

      const isV12Letter = ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'].includes(method);
      const step1Filter = deriveStep1FilterState(method, poolExists);

      const sessionResults = bmResults.filter(r => (r.matchedMethods?.length ?? 0) > 0);
      await saveScanSession({
        id: `${market}-long-${method}-${date}-intraday-${Date.now()}`,
        market: market as import('@/lib/scanner/types').MarketId,
        date,
        direction: 'long' as const,
        multiTimeframeEnabled: false,
        sessionType: 'intraday' as const,
        scanTime: new Date().toISOString(),
        resultCount: sessionResults.length,
        results: sessionResults,
        marketTrend,
        buyMethod: method,
        schemaVersion: (isV12Letter ? 'v12' : 'v11') as 'v11' | 'v12',
        step1Filter,
      });

      summary[method] = { count: sessionResults.length, step1Filter };
    }

    const elapsed = Date.now() - startTime;
    return apiOk({
      market, track, date,
      l2Count: snap.count,
      elapsedMs: elapsed,
      results: summary,
    });
  } catch (err) {
    console.error(`[update-intraday-bm-batch] ${market} ${track} 掃描失敗:`, err);
    return apiError(`${market} ${track} batch scan failed: ${String(err)}`);
  }
}
