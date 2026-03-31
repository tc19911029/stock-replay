import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 30; // just fetching a list, fast

import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { MarketId } from '@/lib/scanner/types';

const querySchema = z.object({ market: z.enum(['TW', 'CN']).default('TW') });

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  const market: MarketId = parsed.data.market;
  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();

  try {
    const stocks = await scanner.getStockList();
    return NextResponse.json({ market, count: stocks.length, stocks });
  } catch (err) {
    console.error('[scanner/list] error:', err);
    return NextResponse.json({ error: '掃描服務暫時無法使用' }, { status: 500 });
  }
}
