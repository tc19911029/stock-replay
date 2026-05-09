/**
 * Cron：每日更新 ETF tracking entries 的 forward returns + ETF 績效快照
 *
 * 排程：週一至五 23:00 CST（vercel.json `0 15 * * 1-5` UTC = 23:00 CST 1-5）
 * 同日 18:00 CST fetch-etf-holdings 之後跑，吃當日新建 tracking 的 D+0 進場價。
 */
import { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { ACTIVE_ETF_LIST } from '@/lib/etf/etfList';
import {
  listAllTrackingEntries,
  saveTrackingEntry,
  savePerformance,
} from '@/lib/etf/etfStorage';
import { updateTrackingEntry } from '@/lib/etf/trackingCalc';
import { computeETFPerformance } from '@/lib/etf/performanceCalc';
import type { ETFPerformanceEntry } from '@/lib/etf/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  // Trading day guard：非交易日且未強制 → skip 避免在假日無新資料下重寫所有 tracking entries
  const force = req.nextUrl.searchParams.get('force') === '1';
  const todayCST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  if (!force && !isTradingDay(todayCST, 'TW')) {
    return apiOk({ skipped: true, reason: 'non-trading day', today: todayCST });
  }

  const date = req.nextUrl.searchParams.get('date') ?? getLastTradingDay('TW');
  let trackingUpdated = 0;
  const errors: string[] = [];

  // 1) 更新所有 open tracking entries
  try {
    const allEntries = await listAllTrackingEntries();
    for (const entry of allEntries) {
      if (entry.windowClosed) continue;
      try {
        const candles = await loadLocalCandles(`${entry.symbol}.TW`, 'TW');
        if (!candles) continue;
        const updated = updateTrackingEntry(entry, candles);
        await saveTrackingEntry(updated);
        trackingUpdated++;
      } catch (err) {
        errors.push(`tracking ${entry.etfCode}/${entry.symbol}: ${errMsg(err)}`);
      }
    }
  } catch (err) {
    errors.push(`list tracking: ${errMsg(err)}`);
  }

  // 2) 重算今日 ETF 績效快照
  const perf: ETFPerformanceEntry[] = [];
  for (const etf of ACTIVE_ETF_LIST) {
    try {
      const candles = await loadLocalCandles(`${etf.etfCode}.TW`, 'TW');
      if (!candles || candles.length === 0) {
        errors.push(`perf ${etf.etfCode}: no candles`);
        continue;
      }
      const entry = computeETFPerformance(etf, candles);
      if (entry) perf.push(entry);
    } catch (err) {
      errors.push(`perf ${etf.etfCode}: ${errMsg(err)}`);
    }
  }

  try {
    await savePerformance(date, perf);
  } catch (err) {
    errors.push(`save perf: ${errMsg(err)}`);
  }

  return apiOk({
    date,
    trackingUpdated,
    perfCount: perf.length,
    errors,
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
