import { NextRequest, NextResponse } from 'next/server';
import { getFundamentals, getMonthlyRevenue } from '@/lib/datasource/FinMindClient';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params;
  const stockId = ticker.replace(/\.(TW|TWO)$/i, '');
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') ?? 'full';  // 'full' | 'revenue'

  try {
    if (mode === 'revenue') {
      const months = Math.min(24, Math.max(1, parseInt(searchParams.get('months') ?? '13')));
      const data = await getMonthlyRevenue(stockId, months);
      return NextResponse.json({ ok: true, data });
    }
    const data = await getFundamentals(stockId);
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
