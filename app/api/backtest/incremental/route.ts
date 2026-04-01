import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner }  from '@/lib/scanner/ChinaScanner';
import type { MarketId, ForwardCandle } from '@/lib/scanner/types';
import {
  runIncrementalFilterTest,
  TESTABLE_FILTERS,
} from '@/lib/backtest/IncrementalFilterTest';
import {
  runRankingBacktest,
  RANKING_DIMENSIONS,
} from '@/lib/backtest/RankingBacktester';

const schema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  /** 要測試的歷史日期列表 */
  dates: z.array(z.string()).min(1),
  /** 每個日期的股票清單（可選，不填則用該日期的 scanner 預設） */
  stocks: z.array(z.object({ symbol: z.string(), name: z.string() })).default([]),
  /** 測試模式：'filter' = 增量 filter 測試, 'ranking' = 排名維度測試, 'both' = 兩個都跑 */
  mode: z.enum(['filter', 'ranking', 'both']).default('both'),
});

export const runtime    = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/backtest/incremental
 *
 * 減法回測 API：
 * - mode='filter':  以純朱老師 SOP 為 baseline，逐一測試每個 filter 的邊際貢獻
 * - mode='ranking': 測試哪個排名維度最能預測贏家
 * - mode='both':    兩個都跑
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const { market, dates, stocks, mode } = parsed.data;
  const marketId = market as MarketId;

  try {
    const scanner = marketId === 'CN' ? new ChinaScanner() : new TaiwanScanner();

    // ── 收集多天的掃描結果 + 前向K線 ──
    const allResults: Array<{ date: string; results: import('@/lib/scanner/types').StockScanResult[] }> = [];
    const allForwardCandles: Record<string, ForwardCandle[]> = {};
    const allBaselineResults: import('@/lib/scanner/types').StockScanResult[] = [];

    for (const date of dates) {
      // 用 pure 模式掃描（baseline = 純朱老師 SOP）
      const stockList = stocks.length > 0 ? stocks : await scanner.getStockList();
      const scanResult = await scanner.scanListAtDatePure(
        stockList.slice(0, 200),  // 限制最多 200 檔避免超時
        date,
      );

      if (scanResult.results.length > 0) {
        allResults.push({ date, results: scanResult.results });
        allBaselineResults.push(...scanResult.results);

        // 取前向K線（掃描日之後的 25 根 K 線，供回測出場用）
        for (const r of scanResult.results) {
          if (allForwardCandles[r.symbol]) continue; // 已有則跳過
          try {
            const candles = await scanner.fetchCandles(r.symbol);
            // 找到 signalDate 的位置，取之後的 K 線
            const signalIdx = candles.findIndex(
              (c) => c.date.startsWith(date),
            );
            if (signalIdx >= 0 && signalIdx + 1 < candles.length) {
              const forward = candles.slice(signalIdx + 1, signalIdx + 26);
              allForwardCandles[r.symbol] = forward.map((c) => ({
                date: c.date,
                open: c.open,
                close: c.close,
                high: c.high,
                low: c.low,
                volume: c.volume,
                ma5: c.ma5,
              }));
            }
          } catch { /* 取不到前向 K 線則跳過 */ }
        }
      }
    }

    if (allBaselineResults.length === 0) {
      return NextResponse.json({
        error: '所有日期都沒有掃描結果',
        dates,
        market: marketId,
      });
    }

    const result: Record<string, unknown> = {
      market: marketId,
      dates,
      totalSignals: allBaselineResults.length,
    };

    // ── Filter 測試 ──
    if (mode === 'filter' || mode === 'both') {
      const filterResult = runIncrementalFilterTest(
        allBaselineResults,
        allForwardCandles,
        TESTABLE_FILTERS,
      );
      result.filterTest = filterResult;
    }

    // ── 排名測試 ──
    if (mode === 'ranking' || mode === 'both') {
      const rankingResult = runRankingBacktest(
        allResults,
        allForwardCandles,
        RANKING_DIMENSIONS,
      );
      result.rankingTest = rankingResult;
    }

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
