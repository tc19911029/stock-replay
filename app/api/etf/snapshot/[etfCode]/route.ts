/**
 * GET /api/etf/snapshot/[etfCode]?date=YYYY-MM-DD
 *
 * 不指定 date 回最新快照。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { findETF } from '@/lib/etf/etfList';
import {
  loadETFSnapshot,
  loadLatestETFSnapshot,
  listSnapshotDates,
} from '@/lib/etf/etfStorage';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ etfCode: string }> },
) {
  const { etfCode } = await params;
  if (!findETF(etfCode)) return apiError(`未追蹤的 ETF：${etfCode}`, 404);

  const date = req.nextUrl.searchParams.get('date');
  const snapshot = date
    ? await loadETFSnapshot(etfCode, date)
    : await loadLatestETFSnapshot(etfCode);

  if (!snapshot) return apiOk({ snapshot: null, availableDates: await listSnapshotDates(etfCode) });
  return apiOk({ snapshot, availableDates: await listSnapshotDates(etfCode) });
}
