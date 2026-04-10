import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime = 'nodejs';
export const maxDuration = 300;

import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { MarketId } from '@/lib/scanner/types';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';

const scannerRunSchema = z.object({
  market:     z.enum(['TW', 'CN']).default('TW'),
  strategyId: z.string().optional(),
  thresholds: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = scannerRunSchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }
  const market: MarketId = parsed.data.market as MarketId;
  const thresholds = resolveThresholds({
    strategyId: parsed.data.strategyId,
    thresholds: parsed.data.thresholds,
  });

  try {
    const scanner = market === 'TW' ? new TaiwanScanner() : new ChinaScanner();
    // ensureFreshCandles 已內建在 scanner.scan() 中，無需額外呼叫
    const { results, partial, marketTrend } = await scanner.scan(thresholds);

    return apiOk({ count: results.length, results, partial, marketTrend });
  } catch (err: unknown) {
    console.error('[scanner/run] error:', err);
    return apiError('掃描服務暫時無法使用');
  }
}
