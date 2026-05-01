import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { evaluateSixConditions, detectTrend } from '@/lib/analysis/trendAnalysis';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { loadLatestETFSnapshot } from '@/lib/etf/etfStorage';
import type { CandleWithIndicators } from '@/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  etfCode: z.string().min(1),
});

interface HoldingResult {
  symbol: string;
  name: string;
  weight: number;
  price: number;
  changePct: number;
  trend: string;
  sixConditions: {
    totalScore: number;
    trend: { pass: boolean };
    position: { pass: boolean };
    kbar: { pass: boolean };
    ma: { pass: boolean };
    volume: { pass: boolean };
    indicator: { pass: boolean };
  };
}

async function processHolding(
  symbol: string,
  name: string,
  weight: number,
  thresholds: ReturnType<typeof resolveThresholds>,
): Promise<HoldingResult | null> {
  // TW active ETF holdings: try .TW first, fallback .TWO (e.g. OTC-listed stocks)
  const candidates = [`${symbol}.TW`, `${symbol}.TWO`];

  let candles: CandleWithIndicators[] | null = null;
  const resolvedName = name;

  for (const ticker of candidates) {
    // market is always TW for active ETF holdings
    const result = await loadLocalCandles(ticker, 'TW');
    if (result && result.length > 0) {
      candles = result;
      break;
    }
  }

  if (!candles || candles.length < 30) return null;

  try {
    const lastIdx = candles.length - 1;
    const last = candles[lastIdx];
    const prev = candles[lastIdx - 1];

    const changePct = prev?.close > 0
      ? +((last.close - prev.close) / prev.close * 100).toFixed(2)
      : 0;

    const sixRaw = evaluateSixConditions(candles, lastIdx, thresholds);
    const trend = detectTrend(candles, lastIdx);

    return {
      symbol,
      name: resolvedName,
      weight,
      price: last.close,
      changePct,
      trend,
      sixConditions: {
        totalScore: sixRaw.totalScore,
        trend:     { pass: sixRaw.trend.pass },
        position:  { pass: sixRaw.position.pass },
        kbar:      { pass: sixRaw.kbar.pass },
        ma:        { pass: sixRaw.ma.pass },
        volume:    { pass: sixRaw.volume.pass },
        indicator: { pass: sixRaw.indicator.pass },
      },
    };
  } catch {
    return null;
  }
}

/** 分批並行，每批最多 concurrency 支 */
async function runInBatches<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { etfCode } = parsed.data;

  const snapshot = await loadLatestETFSnapshot(etfCode);
  if (!snapshot) return apiError(`找不到 ${etfCode} 的持股快照`, 404);

  const thresholds = resolveThresholds({});

  const holdings = await runInBatches(
    snapshot.holdings,
    5,
    (h) => processHolding(h.symbol, h.name, h.weight, thresholds),
  );

  const validHoldings = holdings.filter((h): h is HoldingResult => h !== null);

  return apiOk({
    etfCode: snapshot.etfCode,
    disclosureDate: snapshot.disclosureDate,
    holdings: validHoldings,
  });
}
