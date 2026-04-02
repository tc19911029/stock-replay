import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getFundamentals, getMonthlyRevenue } from '@/lib/datasource/FinMindClient';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

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
  if (!parsed.success) return apiValidationError(parsed.error);
  const { mode } = parsed.data;

  try {
    if (mode === 'revenue') {
      const months = Math.min(24, Math.max(1, parseInt(parsed.data.months ?? '13')));
      const data = await getMonthlyRevenue(stockId, months);
      return apiOk({ data });
    }
    const data = await getFundamentals(stockId);
    return apiOk({ data });
  } catch (e) {
    return apiError((e as Error).message);
  }
}
