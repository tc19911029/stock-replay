import { Candle } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { CandleWithIndicators } from '@/types';

/**
 * Fetch daily candles for a symbol from Yahoo Finance.
 * Used by the scanner (server-side only).
 */
export async function fetchCandlesYahoo(
  ticker: string,
  period = '1y',
): Promise<CandleWithIndicators[]> {
  const url = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,
    `?interval=1d`,
    `&range=${period}`,
    `&includePrePost=false`,
  ].join('');

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${ticker}`);

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${ticker}`);

  const timestamps: number[] = result.timestamp ?? [];
  const q = result.indicators.quote[0];

  const rawCandles: Candle[] = timestamps
    .map((ts, i) => {
      const o = q.open[i];
      const h = q.high[i];
      const l = q.low[i];
      const c = q.close[i];
      const v = q.volume[i];
      if (o == null || h == null || l == null || c == null || isNaN(o)) return null;
      return {
        date:   new Date(ts * 1000).toISOString().split('T')[0],
        open:   +o.toFixed(2),
        high:   +h.toFixed(2),
        low:    +l.toFixed(2),
        close:  +c.toFixed(2),
        volume: v ?? 0,
      };
    })
    .filter((c): c is Candle => c != null);

  return computeIndicators(rawCandles);
}
