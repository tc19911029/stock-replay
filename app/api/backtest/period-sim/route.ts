import { NextRequest } from 'next/server';
import { z } from 'zod';
import { runPeriodSimulation, type PeriodSimConfig, type RankFactor, type DirectionStrategy } from '@/lib/backtest/PeriodSimulator';
import { fetchCandlesRange } from '@/lib/datasource/YahooFinanceDS';
import type { StockScanResult, ForwardCandle } from '@/lib/scanner/types';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 minutes for multi-day sim

const schema = z.object({
  market:            z.enum(['TW', 'CN']),
  startDate:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  initialCapital:    z.number().min(10000),
  maxPositions:      z.number().min(1).max(20),
  positionMode:      z.enum(['full', 'fixedPct']),
  positionPct:       z.number().min(0.05).max(1),
  directionStrategy: z.enum(['longOnly', 'shortOnly', 'auto']),
  rankFactor:        z.enum(['composite', 'surge', 'smartMoney', 'histWinRate', 'sixConditions']),
  // Pre-computed scan data from the client (sessions + cron)
  dailyScanData:     z.array(z.object({
    date:    z.string(),
    results: z.array(z.any()), // StockScanResult[]
  })),
});

/**
 * POST /api/backtest/period-sim
 *
 * 期間模擬 API。客戶端負責收集每日掃描結果，
 * 伺服端負責取得 K 線資料並執行模擬。
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }

  const {
    market, startDate, endDate,
    initialCapital, maxPositions, positionMode, positionPct,
    directionStrategy, rankFactor,
    dailyScanData,
  } = parsed.data;

  try {
    // Collect all unique symbols across the entire simulation period
    const symbolSet = new Set<string>();
    for (const day of dailyScanData) {
      for (const r of day.results as StockScanResult[]) {
        symbolSet.add(r.symbol);
      }
    }

    // Fetch forward candles for all symbols covering the FULL simulation period.
    // Use startDate → endDate + 30-day buffer so even the last day has enough
    // candles for exit logic. This fixes the bug where symbols appearing after
    // the first 45 days were silently skipped because the legacy code fetched
    // candles only from each symbol's "earliest appearance date" with a 45-day cap.
    const today = new Date();
    const utc8  = new Date(today.getTime() + 8 * 3600_000);
    const todayStr = utc8.toISOString().split('T')[0];

    const endBuffer = new Date(endDate);
    endBuffer.setDate(endBuffer.getDate() + 30);
    const fetchEnd = endBuffer.toISOString().split('T')[0] > todayStr
      ? todayStr
      : endBuffer.toISOString().split('T')[0];

    const forwardMap: Record<string, ForwardCandle[]> = {};

    const CONCURRENCY = 10;
    const symbolArr = Array.from(symbolSet);
    for (let i = 0; i < symbolArr.length; i += CONCURRENCY) {
      const batch = symbolArr.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(sym => fetchCandlesRange(sym, startDate, fetchEnd, 12000)),
      );
      for (let j = 0; j < batch.length; j++) {
        const r = settled[j];
        if (r.status !== 'fulfilled' || r.value.length === 0) continue;
        const rawCandles = r.value.filter(c => c.date > startDate && c.date <= todayStr);
        const forwardCandles: ForwardCandle[] = rawCandles.map((c, idx) => {
          let ma5: number | undefined;
          if (idx >= 4) {
            const sum5 = rawCandles.slice(idx - 4, idx + 1).reduce((s, x) => s + x.close, 0);
            ma5 = +(sum5 / 5).toFixed(2);
          }
          return { date: c.date, open: c.open, close: c.close, high: c.high, low: c.low, volume: c.volume, ma5 };
        });
        if (forwardCandles.length > 0) {
          forwardMap[batch[j]] = forwardCandles;
        }
      }
    }

    // Run simulation
    const config: PeriodSimConfig = {
      market: market as 'TW' | 'CN',
      startDate,
      endDate,
      initialCapital,
      maxPositions,
      positionMode: positionMode as 'full' | 'fixedPct',
      positionPct,
      directionStrategy: directionStrategy as DirectionStrategy,
      rankFactor: rankFactor as RankFactor,
    };

    const result = runPeriodSimulation(
      config,
      dailyScanData.map(d => ({ date: d.date, results: d.results as StockScanResult[] })),
      forwardMap,
    );

    return apiOk({ result });
  } catch (err) {
    console.error('[period-sim] error:', err);
    return apiError(err instanceof Error ? err.message : '模擬服務暫時無法使用');
  }
}
