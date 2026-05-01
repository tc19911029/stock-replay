/**
 * GET /api/etf/consensus?date=YYYY-MM-DD&minEtfs=2
 *
 * 回傳共識買榜。預設讀最近一日；若無資料就近 5 個交易日合併再算。
 */
import { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/response';
import { ACTIVE_ETF_LIST } from '@/lib/etf/etfList';
import {
  loadConsensus,
  listConsensusDates,
  loadAllChangesForDate,
  listChangeDates,
} from '@/lib/etf/etfStorage';
import { computeConsensus } from '@/lib/etf/consensusCalc';
import type { ETFChange } from '@/lib/etf/types';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const dateParam = req.nextUrl.searchParams.get('date');
  const minEtfsParam = Number(req.nextUrl.searchParams.get('minEtfs') ?? '2');
  const minEtfs = Number.isFinite(minEtfsParam) && minEtfsParam >= 1 ? minEtfsParam : 2;

  const allCodes = ACTIVE_ETF_LIST.map((e) => e.etfCode);

  // 試讀快取
  if (dateParam) {
    const cached = await loadConsensus(dateParam);
    if (cached) {
      return apiOk({
        date: dateParam,
        windowDays: 1,
        entries: cached.filter((c) => c.etfCodes.length >= minEtfs),
      });
    }
  } else {
    const dates = await listConsensusDates();
    for (const d of dates.slice(0, 5)) {
      const cached = await loadConsensus(d);
      if (cached && cached.length > 0) {
        return apiOk({
          date: d,
          windowDays: 1,
          entries: cached.filter((c) => c.etfCodes.length >= minEtfs),
        });
      }
    }
  }

  // Fallback：合併最近 5 個交易日的 changes 重算
  const recentDates = new Set<string>();
  for (const code of allCodes) {
    for (const d of (await listChangeDates(code)).slice(0, 5)) recentDates.add(d);
  }
  const sortedRecent = Array.from(recentDates).sort().reverse().slice(0, 5);
  const allChanges: ETFChange[] = [];
  for (const d of sortedRecent) {
    allChanges.push(...(await loadAllChangesForDate(d, allCodes)));
  }

  const computed = computeConsensus(allChanges, minEtfs);
  return apiOk({
    date: sortedRecent[0] ?? null,
    windowDays: sortedRecent.length,
    entries: computed,
  });
}
