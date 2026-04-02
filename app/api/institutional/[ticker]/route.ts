import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getInstitutional, getInstitutionalSummary, getMarginBalance } from '@/lib/datasource/FinMindClient';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

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
  if (!parsed.success) return apiValidationError(parsed.error);
  const { mode } = parsed.data;
  const days = Math.min(60, Math.max(1, parseInt(parsed.data.days)));

  try {
    if (mode === 'summary') {
      const summary = await getInstitutionalSummary(stockId, 5);
      return apiOk({ data: summary });
    }
    if (mode === 'margin') {
      const data = await getMarginBalance(stockId, days);
      return apiOk({ data });
    }
    // history
    const data = await getInstitutional(stockId, days);
    return apiOk({ data });
  } catch (e) {
    return apiError((e as Error).message);
  }
}
