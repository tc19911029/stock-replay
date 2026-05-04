import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError } from '@/lib/api/response';
import { getFugleQuote, isFugleAvailable } from '@/lib/datasource/FugleProvider';
import { getTWSESingleIntraday } from '@/lib/datasource/TWSERealtime';
import { getEastMoneySingleQuote } from '@/lib/datasource/EastMoneyRealtime';
import { readIntradaySnapshot } from '@/lib/datasource/IntradayCache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  symbol: z.string().min(1),
});

/**
 * 輕量即時報價 endpoint — 走圖 polling 用，只回今日 OHLCV。
 * 不讀 L1（避免觸發 bulk preload + 2 年資料讀取），直接走 Fugle / MIS / L2。
 */
export async function GET(req: NextRequest) {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = schema.safeParse(params);
  if (!parsed.success) return apiError('symbol 必填', 400);

  const { symbol } = parsed.data;
  const pureCode = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  // suffix 權威：.SS/.SZ → CN；.TW/.TWO → TW；無 suffix 用位數 fallback（4-5 位 TW、6 位 CN）
  const hasCnSuffix = /\.(SS|SZ)$/i.test(symbol);
  const hasTwSuffix = /\.(TW|TWO)$/i.test(symbol);
  const isCN = hasCnSuffix || (!hasTwSuffix && /^\d{6}$/.test(pureCode));
  const isTW = !isCN && (hasTwSuffix || /^\d{4,5}[A-Za-z]?$/.test(pureCode));
  const market = isCN ? 'CN' : (isTW ? 'TW' : null);

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

  let quote: { open: number; high: number; low: number; close: number; volume: number } | null = null;

  // ── TW ──
  if (isTW) {
    // 1) MIS 單股即時
    try {
      const q = await getTWSESingleIntraday(pureCode);
      if (q && q.close > 0 && (!q.date || q.date === today)) {
        quote = { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume };
      }
    } catch { /* fallthrough */ }

    // 2) Fugle
    if (!quote && isFugleAvailable()) {
      try {
        const fq = await getFugleQuote(pureCode);
        if (fq && fq.close > 0) {
          quote = { open: fq.open || fq.close, high: fq.high || fq.close, low: fq.low || fq.close, close: fq.close, volume: fq.volume };
        }
      } catch { /* fallthrough */ }
    }
  }

  // ── CN ──
  if (isCN) {
    try {
      const cnSuffix = /\.SS$/i.test(symbol) ? 'SS' : /\.SZ$/i.test(symbol) ? 'SZ' : undefined;
      const q = await getEastMoneySingleQuote(pureCode, cnSuffix);
      if (q && q.close > 0) {
        quote = { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume };
      }
    } catch { /* fallthrough */ }
  }

  // ── L2 fallback ──
  if (!quote && market) {
    try {
      const snapshot = await readIntradaySnapshot(market as 'TW' | 'CN', today);
      const sq = snapshot?.quotes.find(q => q.symbol === pureCode);
      if (sq && sq.close > 0) {
        quote = { open: sq.open, high: sq.high, low: sq.low, close: sq.close, volume: sq.volume };
      }
    } catch { /* fallthrough */ }
  }

  if (!quote) return apiError(`無法取得 ${symbol} 報價`, 404);

  return apiOk({ symbol, date: today, ...quote });
}
