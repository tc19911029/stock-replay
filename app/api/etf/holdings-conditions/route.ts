import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { loadLatestETFSnapshot } from '@/lib/etf/etfStorage';
import type { StrategySignals, HoldingWithStrategies } from '@/lib/etf/strategySignals';
import type { CandleWithIndicators } from '@/types';
// 提到 top-level：避免 hot path 每次重複 await import 同模組（Round 10 修復）
import { detectBreakoutEntry, detectConsolidationBreakout } from '@/lib/analysis/breakoutEntry';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';
import { detectABCBreakout } from '@/lib/analysis/abcBreakoutEntry';
import { detectBlackKBreakout } from '@/lib/analysis/blackKBreakoutEntry';
import { detectKlineConsolidationBreakout } from '@/lib/analysis/klineConsolidationBreakout';

export const runtime = 'nodejs';

const querySchema = z.object({
  etfCode: z.string().min(1),
});

function detectStrategies(
  candles: CandleWithIndicators[],
  lastIdx: number,
  thresholds: ReturnType<typeof resolveThresholds>,
): StrategySignals {
  const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
  const A = sixConds.isCoreReady ?? false;
  const safe = <T,>(fn: () => T | undefined | null): boolean => {
    try { return !!fn(); } catch { return false; }
  };
  return {
    A,
    B: safe(() => detectBreakoutEntry(candles, lastIdx)),
    C: safe(() => detectConsolidationBreakout(candles, lastIdx)),
    D: safe(() => detectStrategyE(candles, lastIdx)),
    E: safe(() => detectStrategyD(candles, lastIdx)),
    F: safe(() => detectVReversal(candles, lastIdx)),
    G: safe(() => detectABCBreakout(candles, lastIdx)),
    H: safe(() => detectBlackKBreakout(candles, lastIdx)),
    I: safe(() => detectKlineConsolidationBreakout(candles, lastIdx)),
  };
}

async function processHolding(
  symbol: string,
  name: string,
  weight: number,
  thresholds: ReturnType<typeof resolveThresholds>,
): Promise<HoldingWithStrategies | null> {
  const candidates = [`${symbol}.TW`, `${symbol}.TWO`];
  let candles: CandleWithIndicators[] | null = null;

  for (const ticker of candidates) {
    const result = await loadLocalCandles(ticker, 'TW');
    if (result && result.length > 0) { candles = result; break; }
  }

  if (!candles || candles.length < 30) return null;

  try {
    const lastIdx = candles.length - 1;
    const last = candles[lastIdx];
    const prev = candles[lastIdx - 1];

    const changePct = prev?.close > 0
      ? +((last.close - prev.close) / prev.close * 100).toFixed(2)
      : 0;

    const strategies = detectStrategies(candles, lastIdx, thresholds);

    const result: HoldingWithStrategies = { symbol, name, weight, price: last.close, changePct, strategies };
    return result;
  } catch {
    return null;
  }
}

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

  const validHoldings = holdings.filter((h): h is HoldingWithStrategies => h !== null);

  return apiOk({
    etfCode: snapshot.etfCode,
    disclosureDate: snapshot.disclosureDate,
    holdings: validHoldings,
  });
}
