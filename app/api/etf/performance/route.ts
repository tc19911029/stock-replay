/**
 * GET /api/etf/performance?period=ytd&top=11
 *
 * 回傳 ETF 績效排行（依 period 排序）。若快取無資料，現場用 L1 K 棒計算。
 */
import { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/response';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { ACTIVE_ETF_LIST } from '@/lib/etf/etfList';
import { loadPerformance, listPerformanceDates } from '@/lib/etf/etfStorage';
import { computeETFPerformance, rankByPeriod, type PeriodKey } from '@/lib/etf/performanceCalc';
import type { ETFPerformanceEntry } from '@/lib/etf/types';

export const runtime = 'nodejs';

const VALID_PERIODS: PeriodKey[] = ['d1', 'w1', 'm1', 'ytd', 'inception'];

export async function GET(req: NextRequest) {
  const periodParam = (req.nextUrl.searchParams.get('period') ?? 'ytd') as PeriodKey;
  const period: PeriodKey = VALID_PERIODS.includes(periodParam) ? periodParam : 'ytd';
  const topParam = Number(req.nextUrl.searchParams.get('top') ?? '50');
  const top = Number.isFinite(topParam) && topParam > 0 ? topParam : 50;

  let entries: ETFPerformanceEntry[] | null = null;

  // 1) 嘗試讀取快取（最近一個有資料的日期）
  try {
    const dates = await listPerformanceDates();
    for (const d of dates.slice(0, 5)) {
      const cached = await loadPerformance(d);
      if (cached && cached.length > 0) {
        entries = cached;
        break;
      }
    }
  } catch {
    // ignore
  }

  // 2) 快取無資料 → 現場計算
  if (!entries) {
    entries = [];
    for (const etf of ACTIVE_ETF_LIST) {
      try {
        const candles = await loadLocalCandles(`${etf.etfCode}.TW`, 'TW');
        if (!candles || candles.length === 0) continue;
        const e = computeETFPerformance(etf, candles);
        if (e) entries.push(e);
      } catch {
        // skip
      }
    }
  }

  if (entries.length === 0) {
    return apiOk({
      period,
      latestDate: getLastTradingDay('TW'),
      entries: [],
      message: '尚無 ETF 績效資料：請先確認 ETF L1 K 棒已下載（11 檔代號加入 download-candles 名單）',
    });
  }

  const ranked = rankByPeriod(entries, period).slice(0, top);
  return apiOk({
    period,
    latestDate: ranked[0]?.latestDate ?? getLastTradingDay('TW'),
    entries: ranked,
  });
}
