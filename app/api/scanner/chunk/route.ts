import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 120; // one chunk takes ~80s max

import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { MarketId } from '@/lib/scanner/types';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    market?: string;
    stocks?: Array<{ symbol: string; name: string }>;
    strategyId?: string;
    thresholds?: Record<string, unknown>;
    date?: string;  // 歷史日期掃描 (YYYY-MM-DD)
  };

  const market = (body.market === 'CN' ? 'CN' : 'TW') as MarketId;
  const stocks = Array.isArray(body.stocks) ? body.stocks : [];
  const asOfDate = body.date || undefined;
  const thresholds = resolveThresholds({
    strategyId: body.strategyId,
    thresholds: body.thresholds as never,
  });

  if (stocks.length === 0) {
    return NextResponse.json({ results: [] });
  }

  try {
    const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
    const { results, marketTrend } = asOfDate
      ? await scanner.scanListAtDate(stocks, asOfDate, thresholds)
      : await scanner.scanList(stocks, thresholds);
    return NextResponse.json({ results, marketTrend });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
