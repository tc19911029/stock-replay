import { NextRequest } from 'next/server';
import { z } from 'zod';
import { analyzeForwardBatch } from '@/lib/backtest/ForwardAnalyzer';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

const forwardSchema = z.object({
  scanDate: z.string(),
  stocks:   z.array(z.object({ symbol: z.string(), name: z.string(), scanPrice: z.number() })).default([]),
});

export const runtime    = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/backtest/forward
 * Body: {
 *   scanDate: 'YYYY-MM-DD',
 *   stocks: [{ symbol: string; name: string; scanPrice: number }]
 * }
 *
 * Returns forward performance data for each stock after the scan date.
 * Safe to call even if scan date is recent (returns partial data).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = forwardSchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }
  const { scanDate, stocks } = parsed.data;

  if (!scanDate || stocks.length === 0) {
    return apiOk({ performance: [] });
  }

  try {
    const { results: performance, nullCount, totalRequested } = await analyzeForwardBatch(stocks, scanDate);
    return apiOk({ performance, nullCount, totalRequested });
  } catch (err) {
    console.error('[backtest/forward] error:', err);
    return apiError('回測服務暫時無法使用');
  }
}
