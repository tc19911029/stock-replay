// GET /api/cron/append-from-snapshot — 收盤後用全市場即時報價補 L1 K 棒
//
// 比 download-candles 快（5 秒完成全市場），用 TWSE/EastMoney 單一 API 一次拿所有收盤價
// instrumentation.ts 在 isPostCloseWindow 後 30 分鐘觸發

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { isPostCloseWindow, isMarketOpen, getLastTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { suspectsLimitOverwrite } from '@/lib/datasource/limitMoveGuard';

export const runtime = 'nodejs';
export const maxDuration = 120;

async function fetchTWQuotes(): Promise<Map<string, { open: number; high: number; low: number; close: number; volume: number }>> {
  const { getTWSERealtimeIntraday } = await import('@/lib/datasource/TWSERealtime');
  const raw = await getTWSERealtimeIntraday();
  const out = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>();
  for (const [code, q] of raw) {
    if (q.close > 0) out.set(code, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
  }
  return out;
}

async function fetchCNQuotes(): Promise<Map<string, { open: number; high: number; low: number; close: number; volume: number }>> {
  const out = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>();
  try {
    const { getEastMoneyRealtime } = await import('@/lib/datasource/EastMoneyRealtime');
    const raw = await getEastMoneyRealtime();
    for (const [code, q] of raw) {
      if (q.close > 0) out.set(code, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
    }
    if (out.size > 500) return out;
  } catch { /* fallthrough */ }
  return out;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as 'TW' | 'CN';
  const date = getLastTradingDay(market);

  if (!isTradingDay(date, market)) {
    return apiOk({ skipped: true, reason: '非交易日' });
  }
  if (isMarketOpen(market)) {
    return apiOk({ skipped: true, reason: '盤中，等收盤' });
  }
  if (!isPostCloseWindow(market)) {
    return apiOk({ skipped: true, reason: '非盤後窗口' });
  }

  const quotes = market === 'TW' ? await fetchTWQuotes() : await fetchCNQuotes();
  if (quotes.size === 0) return apiOk({ skipped: true, reason: '0 筆報價' });

  const scanner = market === 'TW'
    ? new (await import('@/lib/scanner/TaiwanScanner')).TaiwanScanner()
    : new (await import('@/lib/scanner/ChinaScanner')).ChinaScanner();
  const stocks = await scanner.getStockList();

  let appended = 0;
  let already = 0;
  let skippedLimitUp = 0;
  const limitUpSkipped: string[] = [];

  await Promise.allSettled(stocks.map(async ({ symbol }) => {
    const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const existing = await readCandleFile(symbol, market);
    if (!existing) return;
    if (existing.lastDate > date) { already++; return; }
    const q = quotes.get(code);
    if (!q) return;

    // Limit-up close-overwrite guard（lib/datasource/limitMoveGuard.ts）：
    // 漲跌停股 close 在收盤集合競價，盤中 snapshot tick 可能不是真正收盤。
    const prev = existing.candles[existing.candles.length - 1];
    if (suspectsLimitOverwrite(prev?.close, q, market, code)) {
      console.warn(
        `[append-from-snapshot] ${symbol} ${date} 漲跌停 close 異常 ` +
        `(prev=${prev.close} h=${q.high} l=${q.low} c=${q.close})，skip 寫入避免 L1 污染`
      );
      skippedLimitUp++;
      if (limitUpSkipped.length < 20) limitUpSkipped.push(symbol);
      return;
    }

    await saveLocalCandles(symbol, market, [
      ...existing.candles,
      { date, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume },
    ]);
    appended++;
  }));

  return apiOk({ market, date, appended, already, skippedLimitUp, limitUpSkipped, total: stocks.length });
}
