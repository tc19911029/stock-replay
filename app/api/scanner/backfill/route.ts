import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { runScanPipeline } from '@/lib/scanner/ScanPipeline';

export const runtime = 'nodejs';
export const maxDuration = 300;

const schema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  direction: z.enum(['long', 'short']).default('long'),
  mtf: z.enum(['daily', 'mtf', 'both']).default('both'),
  force: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }

  const { market, date, direction, mtf, force } = parsed.data;

  if (!isTradingDay(date, market as 'TW' | 'CN')) {
    return apiOk({ skipped: true, reason: 'non-trading day (weekend)', date });
  }

  try {
    const result = await runScanPipeline({
      market: market as 'TW' | 'CN',
      date,
      sessionType: 'post_close',
      directions: [direction],
      mtfModes: mtf === 'both' ? ['daily', 'mtf'] : [mtf as 'daily' | 'mtf'],
      force,
    });

    return apiOk(result);
  } catch (err) {
    console.error('[scanner/backfill] error:', err);
    return apiError(String(err));
  }
}
