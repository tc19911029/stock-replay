import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ScanSession, MarketId } from '@/lib/scanner/types';
import { saveScanSession } from '@/lib/storage/scanStorage';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime = 'nodejs';

const schema = z.object({
  market: z.enum(['TW', 'CN']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  direction: z.enum(['long', 'short']).default('long'),
  multiTimeframeEnabled: z.boolean().default(false),
  results: z.array(z.record(z.string(), z.unknown())),
  scanTime: z.string(),
});

/**
 * POST /api/scanner/save-session
 *
 * 純存檔端點：將前端已計算好的掃描結果直接寫入 storage。
 * 不做任何掃描邏輯，永遠覆蓋同日同方向同模式的結果。
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }

  const { market, date, direction, multiTimeframeEnabled, results, scanTime } = parsed.data;

  try {
    const session: ScanSession = {
      id: `${market}-${direction}-${multiTimeframeEnabled ? 'mtf' : 'daily'}-${date}-manual`,
      market: market as MarketId,
      date,
      direction,
      multiTimeframeEnabled,
      sessionType: 'post_close',
      scanTime,
      resultCount: results.length,
      results: results as unknown as ScanSession['results'],
    };

    await saveScanSession(session);

    return apiOk({ saved: true, resultCount: results.length });
  } catch (err) {
    console.error('[scanner/save-session] error:', err);
    return apiError(String(err));
  }
}
