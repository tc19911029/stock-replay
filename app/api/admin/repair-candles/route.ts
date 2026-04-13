/**
 * Layer 1 K線資料修復工具
 *
 * 用途：診斷並修復 Blob 中資料過期的股票
 *
 * GET /api/admin/repair-candles?market=TW&mode=diagnose
 *   → 列出所有過期股票（lastDate 落後超過 staleThreshold 天）
 *
 * GET /api/admin/repair-candles?market=TW&mode=repair&limit=30
 *   → 嘗試重新下載前 limit 支過期股票（預設 30，最多 100）
 *
 * GET /api/admin/repair-candles?market=TW&mode=repair&symbol=2345.TW
 *   → 只修復單一股票
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';
export const maxDuration = 300;

const querySchema = z.object({
  market: z.enum(['TW', 'CN']),
  mode: z.enum(['diagnose', 'repair']).default('diagnose'),
  staleThreshold: z.coerce.number().int().min(1).max(365).default(10),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  symbol: z.string().optional(),
});

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface StockInfo {
  symbol: string;
  name: string;
  lastDate: string | null;
  candleCount: number;
  staleDays: number;
}

export async function GET(req: NextRequest) {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) return apiValidationError(parsed.error);

  const { market, mode, staleThreshold, limit, symbol: singleSymbol } = parsed.data;

  try {
    const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner');
    const { ChinaScanner } = await import('@/lib/scanner/ChinaScanner');
    const scanner = market === 'TW' ? new TaiwanScanner() : new ChinaScanner();

    const lastTradingDate = getLastTradingDay(market);
    const allStocks = await scanner.getStockList();

    // 若指定單一股票，只處理那一支
    const targetStocks = singleSymbol
      ? allStocks.filter(s => s.symbol === singleSymbol)
      : allStocks;

    if (singleSymbol && targetStocks.length === 0) {
      return apiError(`股票 ${singleSymbol} 不在清單中`, 404);
    }

    // ── 1. 批量讀取 Blob 檔案，找出過期股票 ──
    const staleStocks: StockInfo[] = [];
    const BATCH = 20;

    for (let i = 0; i < targetStocks.length; i += BATCH) {
      const batch = targetStocks.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async ({ symbol, name }) => {
          const data = await readCandleFile(symbol, market);
          if (!data) {
            return { symbol, name, lastDate: null, candleCount: 0, staleDays: 9999 };
          }
          const last = data.lastDate;
          const lastMs = new Date(last).getTime();
          const refMs = new Date(lastTradingDate).getTime();
          const calDays = Math.round((refMs - lastMs) / 86_400_000);
          return { symbol, name, lastDate: last, candleCount: data.candles.length, staleDays: calDays };
        }),
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.staleDays > staleThreshold) {
          staleStocks.push(r.value);
        }
      }
    }

    // 按 staleDays 降序（最舊的最先修）
    staleStocks.sort((a, b) => b.staleDays - a.staleDays);

    if (mode === 'diagnose') {
      return apiOk({
        market,
        lastTradingDate,
        staleThreshold,
        totalStocks: targetStocks.length,
        staleCount: staleStocks.length,
        staleStocks: staleStocks.slice(0, 200), // 最多顯示 200 筆
      });
    }

    // ── 2. Repair mode: 重新下載 ──
    const toRepair = staleStocks.slice(0, limit);
    const repaired: string[] = [];
    const failed: Array<{ symbol: string; error: string }> = [];

    for (const stock of toRepair) {
      try {
        await sleep(500); // 避免打爆 API
        const candles = await scanner.fetchCandles(stock.symbol);
        if (candles.length > 0) {
          await saveLocalCandles(stock.symbol, market, candles);
          repaired.push(stock.symbol);
        } else {
          failed.push({ symbol: stock.symbol, error: 'fetchCandles 回傳空陣列（可能已下市）' });
        }
      } catch (err) {
        failed.push({ symbol: stock.symbol, error: (err as Error).message.slice(0, 100) });
      }
    }

    return apiOk({
      market,
      lastTradingDate,
      staleThreshold,
      totalStale: staleStocks.length,
      attempted: toRepair.length,
      repaired: repaired.length,
      failed: failed.length,
      repairedSymbols: repaired,
      failedDetails: failed,
      remaining: Math.max(0, staleStocks.length - toRepair.length),
    });

  } catch (err) {
    return apiError(`修復工具失敗：${(err as Error).message}`);
  }
}
