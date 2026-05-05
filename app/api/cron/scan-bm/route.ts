/**
 * GET /api/cron/scan-bm?market=TW|CN&method=B|C|D|E|F|G|H|I
 *
 * 盤後買法獨立 cron — 每個買法單獨一個 Vercel cron job，
 * 避免全部塞在 scan-tw/scan-cn 造成 300s 超時。
 *
 * 字母對照：
 *   B=回後買上漲、C=盤整突破、D=一字底、E=缺口、F=V形反轉
 *   G=ABC 突破（寶典 Part 11-1 位置 6，2026-05-04 新增）
 *   H=突破大量黑 K（寶典 Part 11-1 位置 8，2026-05-04 新增）
 *   I=K 線橫盤突破（寶典 Part 11-1 位置 3，2026-05-04 新增）
 *
 * 流程：
 *   1. 驗證 CRON_SECRET
 *   2. 確認是交易日
 *   3. 建立 Scanner + 注入 L2
 *   4. 讀 TurnoverRank 前 500（與 scan-tw/cn 一致的股票池）
 *   5. 呼叫 scanner.scanBuyMethod() 取結果
 *   6. 存入 post_close ScanSession
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';
export const maxDuration = 300;

const VALID_METHODS = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] as const;
type BuyMethod = typeof VALID_METHODS[number];

export async function GET(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  // ── Params ──────────────────────────────────────────────────────────────
  const market = req.nextUrl.searchParams.get('market') as 'TW' | 'CN' | null;
  const methodParam = req.nextUrl.searchParams.get('method');
  const dateParam = req.nextUrl.searchParams.get('date');

  if (!market || !['TW', 'CN'].includes(market)) {
    return apiError('market must be TW or CN', 400);
  }
  if (!methodParam || !(VALID_METHODS as readonly string[]).includes(methodParam)) {
    return apiError(`method must be one of ${VALID_METHODS.join(', ')}`, 400);
  }
  const method = methodParam as BuyMethod;

  const date = dateParam ?? getLastTradingDay(market);

  if (!isTradingDay(date, market)) {
    return apiOk({ skipped: true, reason: 'non-trading day', market, method, date });
  }

  try {
    // ── Step 1: 動態 import（Edge-safe 邊界）────────────────────────────
    const { saveScanSession } = await import('@/lib/storage/scanStorage');
    const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
    const { readTurnoverRank } = await import('@/lib/scanner/TurnoverRank');
    const { getActiveStrategyServer } = await import('@/lib/strategy/activeStrategyServer');

    // ── Step 2: 建立 Scanner（L1 快取 fire-and-forget 預熱）────────────────
    const { triggerPreload: triggerL1 } = await import('@/lib/datasource/L1CandleCache');
    triggerL1(market); // 首掃背景預熱，二掃起全命中快取

    let scanner: import('@/lib/scanner/TaiwanScanner').TaiwanScanner | import('@/lib/scanner/ChinaScanner').ChinaScanner;
    if (market === 'CN') {
      const { ChinaScanner } = await import('@/lib/scanner/ChinaScanner');
      scanner = new ChinaScanner();
    } else {
      const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner');
      scanner = new TaiwanScanner();
    }

    // ── Step 3: 注入 L2 快照（與 ScanPipeline 一致）─────────────────────
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
          console.info(`[scan-bm] ${market} ${method} L2 注入 ${l2Injected} 支 (${snap.date})`);
        }
      }
    } catch {
      console.warn(`[scan-bm] ${market} ${method} L2 注入失敗（繼續用 L1）`);
    }

    // ── Step 4: 取得股票清單 + TurnoverRank 前 500 ──────────────────────
    let stocks = await scanner.getStockList();

    const MIN_STOCK_COUNT = market === 'TW' ? 200 : 500;
    if (stocks.length < MIN_STOCK_COUNT) {
      throw new Error(
        `[scan-bm] ${market} getStockList 只回傳 ${stocks.length} 支（< ${MIN_STOCK_COUNT}），` +
        `疑似 API 失敗 fallback，abort 掃描`
      );
    }

    let turnoverRanks: Map<string, number> | null = null;
    try {
      const rank = await readTurnoverRank(market);
      if (rank && rank.symbols.size > 0) {
        stocks = stocks.filter(s => rank.symbols.has(s.symbol));
        turnoverRanks = rank.ranks;
        console.info(`[scan-bm] ${market} ${method} top${rank.topN} 過濾後：${stocks.length} 支`);
      }
    } catch (err) {
      console.warn(`[scan-bm] ${market} ${method} TurnoverRank 讀取失敗，使用全量：`, err);
    }

    // ── Step 5: 買法掃描 ────────────────────────────────────────────────
    const bmResults = await scanner.scanBuyMethod(method, stocks, date);

    // 注入成交額排名
    if (turnoverRanks) {
      for (const r of bmResults) {
        const rank = turnoverRanks.get(r.symbol);
        if (rank) r.turnoverRank = rank;
      }
    }

    // 注入 marketTrend（供 UI 顯示）
    let marketTrend: string | undefined;
    try {
      const activeStrategy = await getActiveStrategyServer();
      const trend = await scanner.getMarketTrend(date);
      marketTrend = String(trend);
      console.info(`[scan-bm] ${market} ${method} 市場趨勢: ${marketTrend} (策略: ${activeStrategy.id})`);
    } catch { /* non-critical */ }

    // ── Step 6: 存入 L4 post_close session ─────────────────────────────
    const bmSession = {
      id: `${market}-long-${method}-${date}-${Date.now()}`,
      market: market as import('@/lib/scanner/types').MarketId,
      date,
      direction: 'long' as const,
      multiTimeframeEnabled: false,
      sessionType: 'post_close' as const,
      scanTime: new Date().toISOString(),
      resultCount: bmResults.length,
      results: bmResults,
      marketTrend,
      buyMethod: method,
    };
    await saveScanSession(bmSession, { allowOverwritePostClose: true });

    console.info(`[scan-bm] ✅ ${market} ${method} ${date}: ${bmResults.length} 檔 L2=${l2Injected}`);

    return apiOk({
      market,
      method,
      date,
      resultCount: bmResults.length,
      l2Injected,
      marketTrend,
    });
  } catch (err) {
    console.error(`[scan-bm] ${market} ${method} 失敗:`, err);
    return apiError(String(err));
  }
}
