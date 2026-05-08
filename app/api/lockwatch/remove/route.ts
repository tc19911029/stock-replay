/**
 * POST /api/lockwatch/remove
 *
 * 用戶手動移除一筆 LockWatch 紀錄（v12 議題 17）。
 *
 * Body: { market: 'TW'|'CN', symbol: string, triggerSignal: 'F'|'N', reason?: string }
 *
 * 行為：
 *   1. 讀今日 snapshot（找不到回 404）
 *   2. 找到符合 (symbol + triggerSignal) 的 record
 *   3. removeLockWatchManually → currentStage = 'manually-removed'
 *   4. 寫回 snapshot
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import {
  loadLatestLockWatchSnapshot,
  saveLockWatchSnapshot,
} from '@/lib/storage/lockWatchStorage';
import { removeLockWatchManually } from '@/lib/scanner/lockWatchManager';

export const runtime = 'nodejs';

interface RemoveBody {
  market?: 'TW' | 'CN';
  symbol?: string;
  triggerSignal?: 'F' | 'N';
  reason?: string;
}

export async function POST(req: NextRequest) {
  let body: RemoveBody;
  try {
    body = (await req.json()) as RemoveBody;
  } catch {
    return apiError('invalid JSON body', 400);
  }

  const { market, symbol, triggerSignal, reason } = body;
  if (!market || !['TW', 'CN'].includes(market)) {
    return apiError('market must be TW or CN', 400);
  }
  if (!symbol || typeof symbol !== 'string') {
    return apiError('symbol required', 400);
  }
  if (!triggerSignal || !['F', 'N'].includes(triggerSignal)) {
    return apiError('triggerSignal must be F or N', 400);
  }

  try {
    const snapshot = await loadLatestLockWatchSnapshot(market);
    if (!snapshot) {
      return apiError('no LockWatch snapshot found', 404);
    }

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const idx = snapshot.records.findIndex(
      (r) => r.symbol === symbol && r.triggerSignal === triggerSignal,
    );
    if (idx < 0) {
      return apiError(`record not found: ${symbol} ${triggerSignal}`, 404);
    }

    const updated = removeLockWatchManually(snapshot.records[idx], today, reason);
    const newRecords = [...snapshot.records];
    newRecords[idx] = updated;

    await saveLockWatchSnapshot({
      ...snapshot,
      records: newRecords,
      lastUpdated: new Date().toISOString(),
    });

    return apiOk({ market, symbol, triggerSignal, currentStage: updated.currentStage });
  } catch (err) {
    console.error('[lockwatch/remove] failed:', err);
    return apiError(`lockwatch remove failed: ${String(err)}`);
  }
}
