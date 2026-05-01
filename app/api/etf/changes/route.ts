/**
 * GET /api/etf/changes?date=YYYY-MM-DD&etfCode=00981A
 *
 * 回傳 ETF 持股異動。
 *   - 不指定 date  → 最近一個有資料的日期
 *   - 不指定 etfCode → 該日所有 ETF
 */
import { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/response';
import { ACTIVE_ETF_LIST } from '@/lib/etf/etfList';
import { loadAllChangesForDate, loadETFChange, listChangeDates } from '@/lib/etf/etfStorage';
import type { ETFChange } from '@/lib/etf/types';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const dateParam = req.nextUrl.searchParams.get('date');
  const etfCode = req.nextUrl.searchParams.get('etfCode');

  const allCodes = ACTIVE_ETF_LIST.map((e) => e.etfCode);

  // 找出實際要使用的日期
  let date = dateParam;
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
    return apiOk({ date: null, changes: [], message: '尚無持股異動資料' });
  }

  let changes: ETFChange[] = [];
  if (etfCode) {
    const c = await loadETFChange(etfCode, date);
    if (c) changes = [c];
  } else {
    changes = await loadAllChangesForDate(date, allCodes);
  }

  return apiOk({ date, changes });
}
