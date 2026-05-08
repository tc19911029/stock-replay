/**
 * GET /api/lockwatch?market=TW|CN&date=YYYY-MM-DD
 *
 * v12 議題 23/61/93 — LockWatch 鎖股觀察名單讀取端點
 *
 * - 不帶 date：回最新 snapshot
 * - 帶 date：回指定日 snapshot
 * - 找不到：回空 records[]，dates 列表給 UI fallback 切換
 *
 * 回傳格式：
 * {
 *   ok: true,
 *   snapshot: LockWatchDailySnapshot | null,
 *   dates: string[]   // 該市場有資料的日期，最新在前
 * }
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import {
  listLockWatchDates,
  loadLatestLockWatchSnapshot,
  loadLockWatchSnapshot,
} from '@/lib/storage/lockWatchStorage';
import type { MarketId } from '@/lib/scanner/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as MarketId;
  const date = req.nextUrl.searchParams.get('date');

  if (!['TW', 'CN'].includes(market)) {
    return apiError(`market must be TW or CN, got: ${market}`, 400);
  }

  try {
    const dates = await listLockWatchDates(market);
    const snapshot = date
      ? await loadLockWatchSnapshot(market, date)
      : await loadLatestLockWatchSnapshot(market);
    return apiOk({ snapshot, dates });
  } catch (err) {
    console.error('[lockwatch] read failed:', err);
    return apiError(`lockwatch read failed: ${String(err)}`);
  }
}
