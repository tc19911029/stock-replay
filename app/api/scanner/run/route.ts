import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { MarketId } from '@/lib/scanner/types';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const market: MarketId = body.market === 'CN' ? 'CN' : 'TW';
  const thresholds = resolveThresholds({
    strategyId: body.strategyId,
    thresholds: body.thresholds,
  });

  try {
    const scanner = market === 'TW' ? new TaiwanScanner() : new ChinaScanner();
    const { results, partial, marketTrend } = await scanner.scan(thresholds);

    return NextResponse.json({ ok: true, count: results.length, results, partial, marketTrend });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
