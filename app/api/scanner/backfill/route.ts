import { NextRequest } from 'next/server';
import { z } from 'zod';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { ScanSession, MarketId } from '@/lib/scanner/types';
import { saveScanSession, loadScanSession } from '@/lib/storage/scanStorage';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime = 'nodejs';
export const maxDuration = 300;

const schema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  force: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }

  const { market, date, force } = parsed.data;
  const marketId = market as MarketId;

  // Skip if already exists (unless force)
  if (!force) {
    const existing = await loadScanSession(marketId, date);
    if (existing) {
      return apiOk({ skipped: true, count: existing.resultCount, date });
    }
  }

  try {
    const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
    const stocks = await scanner.getStockList();

    const { results, marketTrend } = await scanner.scanSOP(stocks, date);

    const session: ScanSession = {
      id: `${market}-${date}-backfill`,
      market: marketId,
      date,
      scanTime: new Date().toISOString(),
      resultCount: results.length,
      results,
    };

    await saveScanSession(session);
    return apiOk({ count: results.length, date, marketTrend });
  } catch (err) {
    console.error('[scanner/backfill] error:', err);
    return apiError(String(err));
  }
}
