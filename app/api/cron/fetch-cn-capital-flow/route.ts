/**
 * Daily cron：抓 CN top 500 主力資金流（收盤後）
 * 用於 CN 版淘汰 #8「主力連續淨流出」
 */
import { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { fetchCapitalFlow } from '@/lib/datasource/EastMoneyCapitalFlow';
import { saveCapitalFlowCN, readCapitalFlowCN, type CapitalFlowRecord } from '@/lib/storage/capitalFlowStorage';
import { computeTurnoverRankAsOfDate } from '@/lib/scanner/TurnoverRank';
import { checkCronAuth } from '@/lib/api/cronAuth';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const dateParam = req.nextUrl.searchParams.get('date') ?? today;

  if (!isTradingDay(dateParam, 'CN')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date: dateParam });
  }

  // 避免重複
  const existing = await readCapitalFlowCN(dateParam);
  if (existing && existing.length > 0) {
    return apiOk({ skipped: true, reason: 'already cached', date: dateParam, count: existing.length });
  }

  const scanner = new ChinaScanner();
  const all = await scanner.getStockList();
  const rank = await computeTurnoverRankAsOfDate('CN', all, dateParam, 500);
  const top500 = [...rank.keys()];

  const perDate = new Map<string, Map<string, number>>();
  let ok = 0, fail = 0;

  for (const symbol of top500) {
    try {
      const flow = await fetchCapitalFlow(symbol, 5);
      const pureSym = symbol.replace(/\.(SS|SZ)$/i, '');
      for (const day of flow) {
        if (!perDate.has(day.date)) perDate.set(day.date, new Map());
        perDate.get(day.date)!.set(pureSym, day.mainNet);
      }
      ok++;
    } catch { fail++; }
    // 東財 rate limit
    await new Promise(r => setTimeout(r, 80));
  }

  // 存所有抓到的交易日
  const savedDates: string[] = [];
  for (const [d, symMap] of perDate) {
    if (!isTradingDay(d, 'CN')) continue;
    const records: CapitalFlowRecord[] = [...symMap.entries()].map(
      ([symbol, mainNet]) => ({ symbol, mainNet })
    );
    await saveCapitalFlowCN(d, records);
    savedDates.push(d);
  }

  return apiOk({
    date: dateParam, ok, fail, savedDates, topCount: top500.length,
  });
}
