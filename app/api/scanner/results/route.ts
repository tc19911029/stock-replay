import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { MarketId } from '@/lib/scanner/types';
import { listScanDates, loadScanSession } from '@/lib/storage/scanStorage';

export const runtime = 'nodejs';

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  const market: MarketId = parsed.data.market;
  const dateParam = parsed.data.date;

  try {
    if (dateParam) {
      // Return the specific date session (full data)
      const session = await loadScanSession(market, dateParam);
      if (!session) return NextResponse.json({ sessions: [] });
      return NextResponse.json({ sessions: [session] });
    }

    // Return all available dates (summary only)
    const dates = await listScanDates(market);
    const sessions = dates.map(d => ({
      id: `${d.market}-${d.date}`,
      market: d.market,
      date: d.date,
      scanTime: d.scanTime,
      resultCount: d.resultCount,
    }));

    return NextResponse.json({ sessions });
  } catch (err: unknown) {
    console.error('[scanner/results] error:', err);
    return NextResponse.json({ error: '掃描服務暫時無法使用' }, { status: 500 });
  }
}
