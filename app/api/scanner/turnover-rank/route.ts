import { NextRequest } from 'next/server';
import { z } from 'zod';
import { readTurnoverRank } from '@/lib/scanner/TurnoverRank';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime = 'nodejs';

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('CN'),
});

/**
 * GET /api/scanner/turnover-rank?market=CN
 * 回傳全市場 20 日均成交額排名（symbols 按降序，index = 排名 - 1）
 */
export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);

  try {
    const idx = await readTurnoverRank(parsed.data.market);
    if (!idx) return apiOk({ symbols: [], date: null, topN: 0 });
    // ranks 是 Map<symbol, rank>，依 rank 升序輸出 symbols 陣列
    const sortedByRank = [...idx.ranks.entries()].sort((a, b) => a[1] - b[1]).map(([s]) => s);
    return apiOk(
      { symbols: sortedByRank, date: idx.date, topN: idx.topN },
      { headers: { 'Cache-Control': 'public, max-age=300' } },
    );
  } catch (err) {
    console.error('[turnover-rank] error:', err);
    return apiError('failed to read turnover rank');
  }
}
