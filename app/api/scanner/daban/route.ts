import { NextRequest } from 'next/server';
import { z } from 'zod';
import { loadDabanSession, listDabanDates, saveDabanSession } from '@/lib/storage/dabanStorage';
import { scanDabanRealtime } from '@/lib/scanner/DabanScanner';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime = 'nodejs';
export const maxDuration = 120;

const querySchema = z.object({
  date: z.string().optional(),
});

const postSchema = z.object({
  date: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);

  try {
    if (parsed.data.date) {
      let session = await loadDabanSession(parsed.data.date);
      if (!session) {
        // 找不到該日期 → 自動 fallback 到最近有資料的日期
        const dates = await listDabanDates();
        // dates 已按日期降序排列，找第一個 <= 請求日期的
        const nearest = dates.find(d => d.date <= parsed.data.date!);
        if (nearest) {
          session = await loadDabanSession(nearest.date);
        }
      }
      if (!session) return apiOk({ session: null });
      return apiOk({ session });
    }

    const dates = await listDabanDates();
    return apiOk({ dates });
  } catch (err: unknown) {
    console.error('[scanner/daban] error:', err);
    return apiError('打板掃描服務暫時無法使用');
  }
}

/**
 * POST /api/scanner/daban — 即時打板掃描
 *
 * 盤中：合併即時報價 + 本地 K 線
 * 盤後：純本地 K 線掃描
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return apiValidationError(parsed.error);

  try {
    const { getLastTradingDay } = await import('@/lib/datasource/marketHours');
    const date = parsed.data.date || getLastTradingDay('CN');

    const session = await scanDabanRealtime(date);
    await saveDabanSession(session);

    return apiOk({ session });
  } catch (err: unknown) {
    console.error('[scanner/daban] POST error:', err);
    return apiError('打板掃描失敗: ' + String(err));
  }
}
