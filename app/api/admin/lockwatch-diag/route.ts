/**
 * GET /api/admin/lockwatch-diag
 *
 * LockWatch 系統健康檢查（v12 ops 用）
 *
 * 回傳：
 * - TW / CN 各市場最新 snapshot 日期
 * - 各市場 records 計數（依 currentStage 分桶）
 * - 各市場 records 計數（依 triggerSignal F/N 分桶）
 * - 最近 7 天有資料的日期（檢查 cron 是否正常）
 *
 * 用途：production 出 bug 時快速確認 LockWatch cron 跑沒跑、有沒有寫入。
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkAdminAuth } from '@/lib/api/adminAuth';
import {
  listLockWatchDates,
  loadLatestLockWatchSnapshot,
} from '@/lib/storage/lockWatchStorage';
import type { LockWatchRecord } from '@/lib/scanner/lockWatchTypes';
import type { MarketId } from '@/lib/scanner/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MarketStats {
  market: MarketId;
  latestDate: string | null;
  totalRecords: number;
  byStage: Record<LockWatchRecord['currentStage'], number>;
  bySignal: Record<'F' | 'N', number>;
  recentDates: string[];
}

const EMPTY_STAGE: Record<LockWatchRecord['currentStage'], number> = {
  'pending-breakout': 0,
  observation: 0,
  'entry-signal': 0,
  purchased: 0,
  revoked: 0,
  'manually-removed': 0,
  'structure-broken': 0,
};

async function statsFor(market: MarketId): Promise<MarketStats> {
  const dates = await listLockWatchDates(market);
  const recentDates = dates.slice(0, 7);
  const snap = await loadLatestLockWatchSnapshot(market);
  const byStage = { ...EMPTY_STAGE };
  const bySignal: Record<'F' | 'N', number> = { F: 0, N: 0 };
  if (snap) {
    for (const r of snap.records) {
      byStage[r.currentStage] = (byStage[r.currentStage] ?? 0) + 1;
      bySignal[r.triggerSignal] = (bySignal[r.triggerSignal] ?? 0) + 1;
    }
  }
  return {
    market,
    latestDate: snap?.date ?? null,
    totalRecords: snap?.records.length ?? 0,
    byStage,
    bySignal,
    recentDates,
  };
}

export async function GET(req: NextRequest) {
  const denied = checkAdminAuth(req);
  if (denied) return denied;

  try {
    const [tw, cn] = await Promise.all([statsFor('TW'), statsFor('CN')]);
    return apiOk({
      generatedAt: new Date().toISOString(),
      markets: { TW: tw, CN: cn },
    });
  } catch (err) {
    console.error('[admin/lockwatch-diag] failed:', err);
    return apiError(`lockwatch-diag failed: ${String(err)}`);
  }
}
