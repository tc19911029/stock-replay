import { NextRequest, NextResponse } from 'next/server';
import { getInstitutional, getInstitutionalSummary, getMarginBalance } from '@/lib/datasource/FinMindClient';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params;
  const stockId = ticker.replace(/\.(TW|TWO)$/i, '');
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') ?? 'summary';  // 'summary' | 'history' | 'margin'
  const days = Math.min(60, Math.max(1, parseInt(searchParams.get('days') ?? '20')));

  try {
    if (mode === 'summary') {
      const summary = await getInstitutionalSummary(stockId, 5);
      return NextResponse.json({ ok: true, data: summary });
    }
    if (mode === 'margin') {
      const data = await getMarginBalance(stockId, days);
      return NextResponse.json({ ok: true, data });
    }
    // history
    const data = await getInstitutional(stockId, days);
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
