import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getFundamentals, getMonthlyRevenue } from '@/lib/datasource/FinMindClient';

const querySchema = z.object({
  mode: z.enum(['full', 'revenue']).default('full'),
  months: z.string().optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params;
  const stockId = ticker.replace(/\.(TW|TWO)$/i, '');
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  const { mode } = parsed.data;

  try {
    if (mode === 'revenue') {
      const months = Math.min(24, Math.max(1, parseInt(parsed.data.months ?? '13')));
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
