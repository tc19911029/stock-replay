/**
 * GET /api/etf/tracking?etfCode=00981A&symbol=2330&open=true
 *
 * 回傳 ETF tracking entries。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { listAllTrackingEntries } from '@/lib/etf/etfStorage';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const etfCode = req.nextUrl.searchParams.get('etfCode') ?? undefined;
    const symbol = req.nextUrl.searchParams.get('symbol') ?? undefined;
    const onlyOpen = req.nextUrl.searchParams.get('open') === 'true';

    let entries = await listAllTrackingEntries(etfCode);
    if (symbol) entries = entries.filter((e) => e.symbol === symbol);
    if (onlyOpen) entries = entries.filter((e) => !e.windowClosed);

    // 預設由新到舊
    entries.sort((a, b) => b.addedDate.localeCompare(a.addedDate));

    return apiOk({ entries, total: entries.length });
  } catch (err) {
    console.error('[etf/tracking] error:', err);
    return apiError('ETF tracking 查詢暫時無法使用');
  }
}
