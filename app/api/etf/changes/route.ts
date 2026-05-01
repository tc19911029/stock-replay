/**
 * GET /api/etf/changes?etfCode=00981A&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
 *
 * 回傳 ETF 持股異動。
 *   - fromDate/toDate 都給 → 即時計算兩快照 diff（任意日期比較）
 *   - 只給 toDate（或舊版 date）→ 讀預存 ETFChange
 *   - 都不給 → 最近一筆預存
 *   - availableDates → 快照可用日期（供前端建日期選擇器）
 */
import { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/response';
import { ACTIVE_ETF_LIST } from '@/lib/etf/etfList';
import {
  loadAllChangesForDate,
  loadETFChange,
  listChangeDates,
  loadETFSnapshot,
  listSnapshotDates,
} from '@/lib/etf/etfStorage';
import { computeETFChange } from '@/lib/etf/holdingsDiff';
import type { ETFChange } from '@/lib/etf/types';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const etfCode   = p.get('etfCode');
  const fromDate  = p.get('fromDate');
  const toDate    = p.get('toDate') ?? p.get('date');   // backwards compat

  const allCodes = ACTIVE_ETF_LIST.map((e) => e.etfCode);

  // ── availableDates：快照日期，供前端建 picker ──────────────────────
  let availableDates: string[] = [];
  if (etfCode) {
    availableDates = await listSnapshotDates(etfCode);
  }

  // ── 即時 diff：fromDate + toDate 都給時 ──────────────────────────
  if (etfCode && fromDate && toDate && fromDate !== toDate) {
    const [prior, current] = await Promise.all([
      loadETFSnapshot(etfCode, fromDate),
      loadETFSnapshot(etfCode, toDate),
    ]);
    if (!prior || !current) {
      return apiOk({ date: toDate, fromDate, toDate, changes: [], availableDates, message: '快照資料不足' });
    }
    const change = computeETFChange(prior, current);
    return apiOk({ date: toDate, fromDate, toDate, changes: [change], availableDates });
  }

  // ── 舊路徑：讀預存 ETFChange ─────────────────────────────────────
  let date = toDate;
  if (!date) {
    if (etfCode) {
      const dates = await listChangeDates(etfCode);
      date = dates[0] ?? null;
    } else {
      const allDates = new Set<string>();
      for (const code of allCodes) {
        for (const d of (await listChangeDates(code)).slice(0, 1)) allDates.add(d);
      }
      date = Array.from(allDates).sort().reverse()[0] ?? null;
    }
  }

  if (!date) {
    return apiOk({ date: null, changes: [], availableDates, message: '尚無持股異動資料' });
  }

  let changes: ETFChange[] = [];
  if (etfCode) {
    const c = await loadETFChange(etfCode, date);
    if (c) changes = [c];
  } else {
    changes = await loadAllChangesForDate(date, allCodes);
  }

  return apiOk({ date, changes, availableDates });
}
