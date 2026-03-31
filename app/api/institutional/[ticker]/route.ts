import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getInstitutional, getInstitutionalSummary, getMarginBalance } from '@/lib/datasource/FinMindClient';

const querySchema = z.object({
  mode: z.enum(['summary', 'history', 'margin']).default('summary'),
  days: z.string().default('20'),
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
  const days = Math.min(60, Math.max(1, parseInt(parsed.data.days)));

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
