/**
 * TWSE / TPEx direct data source — fallback when Yahoo Finance is unavailable.
 *
 * TWSE (listed stocks, .TW suffix):
 *   https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=YYYYMMDD&stockNo=TICKER
 *
 * TPEx (OTC stocks, .TWO suffix):
 *   https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php
 *   (returns HTML — not supported here; falls back to empty)
 *
 * Returns up to `months` of daily candles, sorted oldest-first, with indicators computed.
 */

import type { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';

type TWSERow = [string, string, string, string, string, string, string, string, string];

interface TWSEResponse {
  stat?: string;
  data?: TWSERow[];
}

/** Parse ROC calendar date "115/03/28" → "2026-03-28" */
function parseROCDate(s: string): string | null {
  const parts = s.split('/');
  if (parts.length !== 3) return null;
  const year = parseInt(parts[0], 10) + 1911;
  return `${year}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
}

/** Strip commas and parse float */
function num(s: string): number {
  return parseFloat(s.replace(/,/g, ''));
}

/** Fetch one month of TWSE daily data */
async function fetchTWSEMonth(ticker: string, dateStr: string): Promise<Candle[]> {
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateStr}&stockNo=${ticker}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; rockstock/2.0)' },
    });
    if (!res.ok) return [];
    const json = await res.json() as TWSEResponse;
    if (json.stat !== 'OK' || !json.data) return [];

    return json.data
      .map(row => {
        const date = parseROCDate(row[0]);
        if (!date) return null;
        const open  = num(row[3]);
        const high  = num(row[4]);
        const low   = num(row[5]);
        const close = num(row[6]);
        // TWSE volume is in shares; convert to lots (張, 1000 shares each)
        const volume = Math.round(num(row[1]) / 1000);
        if (isNaN(close) || close <= 0) return null;
        return { date, open, high, low, close, volume };
      })
      .filter((c): c is Candle => c !== null);
  } catch {
    return [];
  }
}

/**
 * Fetch the last `months` months of TWSE daily candles for a listed (.TW) stock.
 * Returns CandleWithIndicators[], sorted oldest-first.
 */
export async function fetchCandlesTWSE(
  ticker: string,
  months = 14
): Promise<CandleWithIndicators[]> {
  const now = new Date();

  // Fetch all months in parallel
  const promises = Array.from({ length: months }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`;
    return fetchTWSEMonth(ticker, dateStr);
  });

  const results = await Promise.all(promises);
  const all: Candle[] = results.flat();

  if (all.length === 0) return [];

  // Sort oldest-first, deduplicate by date
  const seen = new Set<string>();
  const sorted = all
    .filter(c => { if (seen.has(c.date)) return false; seen.add(c.date); return true; })
    .sort((a, b) => a.date.localeCompare(b.date));

  return computeIndicators(sorted);
}
