import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 120; // one chunk takes ~80s max

import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { MarketId } from '@/lib/scanner/types';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';

const scannerChunkSchema = z.object({
  market:     z.enum(['TW', 'CN']).default('TW'),
  stocks:     z.array(z.object({ symbol: z.string(), name: z.string() })).default([]),
  strategyId: z.string().optional(),
  thresholds: z.record(z.string(), z.unknown()).optional(),
  date:       z.string().optional(),
  /** 掃描模式：full=完整管線, pure=純朱家泓六大條件 */
  mode:       z.enum(['full', 'pure']).default('full'),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = scannerChunkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const market = parsed.data.market as MarketId;
  const stocks = parsed.data.stocks;
  const asOfDate = parsed.data.date || undefined;
  const thresholds = resolveThresholds({
    strategyId: parsed.data.strategyId,
    thresholds: parsed.data.thresholds as never,
  });

  if (stocks.length === 0) {
    return NextResponse.json({ results: [] });
  }

  try {
    const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
    const isPure = parsed.data.mode === 'pure';

    let scanResult;
    if (isPure && asOfDate) {
      scanResult = await scanner.scanListAtDatePure(stocks, asOfDate, thresholds);
    } else if (isPure) {
      // Live scan with pure mode — use the same date-based method with today
      const today = new Date().toISOString().split('T')[0];
      scanResult = await scanner.scanListAtDatePure(stocks, today, thresholds);
    } else if (asOfDate) {
      scanResult = await scanner.scanListAtDate(stocks, asOfDate, thresholds);
    } else {
      scanResult = await scanner.scanList(stocks, thresholds);
    }

    const { results, marketTrend } = scanResult;
    return NextResponse.json({ results, marketTrend, mode: parsed.data.mode });
  } catch (err) {
    console.error('[scanner/chunk] error:', err);
    return NextResponse.json({ error: '掃描服務暫時無法使用' }, { status: 500 });
  }
}
