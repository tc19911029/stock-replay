import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime = 'nodejs';
export const maxDuration = 30; // just fetching a list, fast

import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { MarketId } from '@/lib/scanner/types';

const querySchema = z.object({ market: z.enum(['TW', 'CN']).default('TW') });

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const market: MarketId = parsed.data.market;
  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();

  try {
    const stocks = await scanner.getStockList();
    return apiOk({ market, count: stocks.length, stocks });
  } catch (err) {
    console.error('[scanner/list] error:', err);
    return apiError('掃描服務暫時無法使用');
  }
}
