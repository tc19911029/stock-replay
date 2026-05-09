/**
 * POST /api/lockwatch/mark-purchased
 *
 * 用戶買進 LockWatch 名單中的股票（議題 62）。
 * 標 currentStage='purchased' + 紀錄 entryPrice。
 *
 * Body: { market: 'TW'|'CN', symbol: string, triggerSignal: 'F'|'N', entryPrice: number }
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import {
  loadLatestLockWatchSnapshot,
  saveLockWatchSnapshot,
} from '@/lib/storage/lockWatchStorage';
import { markLockWatchPurchased } from '@/lib/scanner/lockWatchManager';

export const runtime = 'nodejs';

interface Body {
  market?: 'TW' | 'CN';
  symbol?: string;
  triggerSignal?: 'F' | 'N';
  entryPrice?: number;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return apiError('invalid JSON', 400);
  }
  const { market, symbol, triggerSignal, entryPrice } = body;
  if (!market || !['TW', 'CN'].includes(market)) return apiError('market must be TW or CN', 400);
  if (!symbol) return apiError('symbol required', 400);
  if (!triggerSignal || !['F', 'N'].includes(triggerSignal)) return apiError('triggerSignal must be F or N', 400);
  if (!entryPrice || entryPrice <= 0) return apiError('entryPrice required (positive)', 400);

  try {
    const snapshot = await loadLatestLockWatchSnapshot(market);
    if (!snapshot) return apiError('no LockWatch snapshot', 404);

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const idx = snapshot.records.findIndex((r) => r.symbol === symbol && r.triggerSignal === triggerSignal);
    if (idx < 0) return apiError(`record not found: ${symbol} ${triggerSignal}`, 404);

    const updated = markLockWatchPurchased(snapshot.records[idx], today, entryPrice);
    const newRecords = [...snapshot.records];
    newRecords[idx] = updated;
    await saveLockWatchSnapshot({
      ...snapshot,
      records: newRecords,
      lastUpdated: new Date().toISOString(),
    });

    return apiOk({ market, symbol, triggerSignal, entryPrice, currentStage: updated.currentStage });
  } catch (err) {
    console.error('[lockwatch/mark-purchased] failed:', err);
    return apiError(`mark-purchased failed: ${String(err)}`);
  }
}
