/**
 * GET /api/cron/scan-bm-batch?market=TW|CN&track=bullish|reversal|system
 *
 * 把原本 14 個 scan-bm cron 合併成 4 個（A 預選池 + 3 個軌道 batch）：
 *   - track=bullish: B/C/E/J/K/L/M/P 8 個多頭軌（讀 Step 1 池子，要等 A 跑完）
 *   - track=reversal: D/F/N/O 4 個反轉軌（全市場掃，不過 Step 1）
 *   - track=system: Q 戰法軌（全市場 + 戒律檢查）
 *
 * 設計優勢：
 *   - 同一 batch 內 8 個 method 共用同一份 stockList / L2 / TurnoverRank / marketTrend
 *     → 比 8 個獨立 cron 各自重新 inject 省 ~7 倍前置時間
 *   - L1 cache 預熱一次，後續 method 全 cache hit
 *   - 一次寫入多個 ScanSession（B/C/E/J/K/L/M/P 8 個 sessions）
 *
 * 排程依賴（vercel.json 實際時間需保證）：
 *   14:02 scan-tw（A 預選池 → 寫 step1-pool cache）
 *   14:08 scan-bm-batch?track=bullish  ← 讀 step1-pool
 *   14:11 scan-bm-batch?track=reversal
 *   14:13 scan-bm-batch?track=system
 *
 * 對應 scan-bm/route.ts 的 14 個獨立 cron，本 endpoint 取代之；舊 endpoint
 * 暫時保留兼容歷史 cron（之後 vercel.json 排程改用本 endpoint 後可刪）。
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';
export const maxDuration = 300;

const TRACKS = {
  bullish: ['B', 'C', 'E', 'J', 'K', 'L', 'M', 'P'],   // 多頭軌（書本 8 種進場位置）
  reversal: ['D', 'F', 'N', 'O'],                      // 反轉軌（抓底/V 反轉）
  system: ['Q'],                                       // 戰法軌（朱老師三均線）
} as const;
type TrackName = keyof typeof TRACKS;

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const market = req.nextUrl.searchParams.get('market') as 'TW' | 'CN' | null;
  const trackParam = req.nextUrl.searchParams.get('track');
  const dateParam = req.nextUrl.searchParams.get('date');

  if (!market || !['TW', 'CN'].includes(market)) {
    return apiError('market must be TW or CN', 400);
  }
  if (!trackParam || !(trackParam in TRACKS)) {
    return apiError(`track must be one of ${Object.keys(TRACKS).join(', ')}`, 400);
  }
  const track = trackParam as TrackName;
  const methods = TRACKS[track];
  const date = dateParam ?? getLastTradingDay(market);

  if (!isTradingDay(date, market)) {
    return apiOk({ skipped: true, reason: 'non-trading day', market, track, date });
  }

  const startTime = Date.now();

  try {
    // ── Imports ──────────────────────────────────────────────────────
    const { saveScanSession } = await import('@/lib/storage/scanStorage');
    const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
    const { readTurnoverRank } = await import('@/lib/scanner/TurnoverRank');
    const { triggerPreload: triggerL1 } = await import('@/lib/datasource/L1CandleCache');
    const { appendLockWatchRecords } = await import('@/lib/storage/lockWatchStorage');
    const { createLockWatchFromF, createLockWatchFromN } = await import('@/lib/scanner/lockWatchManager');
    triggerL1(market);

    let scanner: import('@/lib/scanner/TaiwanScanner').TaiwanScanner | import('@/lib/scanner/ChinaScanner').ChinaScanner;
    if (market === 'CN') {
      const { ChinaScanner } = await import('@/lib/scanner/ChinaScanner');
      scanner = new ChinaScanner();
    } else {
      const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner');
      scanner = new TaiwanScanner();
    }

    // ── L2 inject（共用一次）──────────────────────────────────────
    let l2Injected = 0;
    try {
      const snap = await readIntradaySnapshot(market, date);
      if (snap && snap.quotes.length > 0) {
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
        if (realtimeQuotes.size > 0) {
          scanner.setRealtimeQuotes(realtimeQuotes);
          l2Injected = realtimeQuotes.size;
        }
      }
    } catch { /* L2 fail OK，繼續用 L1 */ }

    // ── Stock list + TurnoverRank（共用一次）──────────────────────
    let stocks = await scanner.getStockList();
    const MIN_STOCK_COUNT = market === 'TW' ? 200 : 500;
    if (stocks.length < MIN_STOCK_COUNT) {
      throw new Error(`[scan-bm-batch] ${market} stocks=${stocks.length} < ${MIN_STOCK_COUNT}`);
    }
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

    // ── Sequential per-method scan（避免並行重複算 L1 cache 預熱）──
    const summary: Record<string, { count: number; lockWatch: number }> = {};
    type LockWatchMethod = 'F' | 'N';
    for (const method of methods) {
      const m = method as 'B' | 'C' | 'D' | 'E' | 'F' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q';
      const bmResults = await scanner.scanBuyMethod(m, stocks, date);

      if (turnoverRanks) {
        for (const r of bmResults) {
          const rank = turnoverRanks.get(r.symbol);
          if (rank) r.turnoverRank = rank;
        }
      }

      const isV12Letter = ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'].includes(m);
      await saveScanSession({
        id: `${market}-long-${m}-${date}-${Date.now()}`,
        market: market as import('@/lib/scanner/types').MarketId,
        date,
        direction: 'long' as const,
        multiTimeframeEnabled: false,
        sessionType: 'post_close' as const,
        scanTime: new Date().toISOString(),
        resultCount: bmResults.length,
        results: bmResults,
        marketTrend,
        buyMethod: m,
        schemaVersion: (isV12Letter ? 'v12' : 'v11') as 'v11' | 'v12',
      }, { allowOverwritePostClose: true });

      // ── F/N 寫 LockWatch ─────────────────────────────────────
      let lockWatchWritten = 0;
      if (m === 'F' || m === 'N') {
        try {
          const records = bmResults
            .filter((r) => r.lockWatchPayload?.triggerPrice != null)
            .map((r) => {
              const p = r.lockWatchPayload!;
              if (m === 'F') {
                return createLockWatchFromF({
                  symbol: r.symbol,
                  market: market as 'TW' | 'CN',
                  triggeredDate: date,
                  triggerPrice: p.triggerPrice,
                  vBottom: p.vBottom,
                });
              }
              if (!p.patternType) return null;
              return createLockWatchFromN({
                symbol: r.symbol,
                market: market as 'TW' | 'CN',
                triggeredDate: date,
                patternType: p.patternType,
                triggerPrice: p.triggerPrice,
                patternTargetPrice: p.patternTargetPrice,
                patternAchievementRate: p.patternAchievementRate,
              });
            })
            .filter((x): x is NonNullable<typeof x> => x != null);
          if (records.length > 0) {
            await appendLockWatchRecords(market as 'TW' | 'CN', date, records);
            lockWatchWritten = records.length;
          }
        } catch (err) {
          console.warn(`[scan-bm-batch] ${market} ${m} LockWatch 寫入失敗:`, err);
        }
      }

      summary[m as LockWatchMethod | string] = { count: bmResults.length, lockWatch: lockWatchWritten };
    }

    const elapsedMs = Date.now() - startTime;
    console.info(
      `[scan-bm-batch] ✅ ${market} ${track} ${date} elapsed=${(elapsedMs/1000).toFixed(1)}s methods=${methods.join('/')} `,
      summary,
    );

    return apiOk({
      market,
      track,
      date,
      methods,
      summary,
      l2Injected,
      marketTrend,
      elapsedMs,
    });
  } catch (err) {
    console.error(`[scan-bm-batch] ${market} ${track} 失敗:`, err);
    return apiError(`scan-bm-batch failed: ${String(err).slice(0, 200)}`);
  }
}
