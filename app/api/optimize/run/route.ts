import { NextRequest }   from 'next/server';
import { gridSearch, GridSearchConfig, ParamRange, computeCompositeScore } from '@/lib/optimizer/GridSearchEngine';
import { BASE_THRESHOLDS } from '@/lib/strategy/StrategyConfig';
import { DEFAULT_STRATEGY } from '@/lib/backtest/BacktestEngine';
import type { MarketId }   from '@/lib/scanner/types';

export const runtime     = 'nodejs';
export const maxDuration = 300;   // Vercel 最大 300s

/**
 * POST /api/optimize/run
 *
 * Body: {
 *   paramRanges: ParamRange[],
 *   testDates:   string[],
 *   market:      'TW' | 'CN',
 *   stockLimit?: number,
 *   holdDays?:   number,
 *   stopLoss?:   number,
 * }
 *
 * Returns: streaming JSON lines, each line is one search result
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    paramRanges?: ParamRange[];
    testDates?:   string[];
    market?:      string;
    stockLimit?:  number;
    holdDays?:    number;
    stopLoss?:    number;
  };

  const paramRanges = Array.isArray(body.paramRanges) ? body.paramRanges : [];
  const testDates   = Array.isArray(body.testDates)   ? body.testDates   : [];
  const market      = (body.market === 'CN' ? 'CN' : 'TW') as MarketId;
  const stockLimit  = body.stockLimit ?? 30;

  if (paramRanges.length === 0 || testDates.length === 0) {
    return new Response(JSON.stringify({ error: '請至少選擇一個參數範圍和一個測試日期' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const config: GridSearchConfig = {
    paramRanges,
    fixedThresholds: { ...BASE_THRESHOLDS },
    backtestParams:  {
      ...DEFAULT_STRATEGY,
      holdDays: body.holdDays ?? DEFAULT_STRATEGY.holdDays,
      stopLoss: body.stopLoss ? body.stopLoss / 100 : DEFAULT_STRATEGY.stopLoss,
    },
    testDates,
    market,
    stockLimit,
  };

  const abortController = new AbortController();
  req.signal.addEventListener('abort', () => abortController.abort());

  const encoder = new TextEncoder();
  const stream  = new ReadableStream({
    async start(controller) {
      try {
        for await (const { result, progress } of gridSearch(config, abortController.signal)) {
          const line = JSON.stringify({
            type: 'result',
            result: {
              params:         result.params,
              compositeScore: result.compositeScore,
              tradeCount:     result.tradeCount,
              winRate:        result.winRate,
              avgReturn:      result.avgReturn,
              stats:          result.stats,
            },
            progress: {
              current:   progress.current,
              total:     progress.total,
              elapsedMs: progress.elapsedMs,
              bestScore: progress.bestSoFar?.compositeScore ?? 0,
              bestWinRate: progress.bestSoFar?.winRate ?? 0,
            },
          }) + '\n';
          controller.enqueue(encoder.encode(line));
        }

        controller.enqueue(encoder.encode(JSON.stringify({ type: 'done' }) + '\n'));
      } catch (err) {
        controller.enqueue(encoder.encode(
          JSON.stringify({ type: 'error', message: String(err) }) + '\n'
        ));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked',
    },
  });
}
