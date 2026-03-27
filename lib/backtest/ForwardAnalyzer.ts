import { fetchCandlesRange } from '@/lib/datasource/YahooFinanceDS';
import { StockForwardPerformance, ForwardCandle } from '@/lib/scanner/types';

// 增加到 45 曆天，確保春節/國慶長假後仍能覆蓋 20+ 個交易日
const FORWARD_WINDOW_DAYS = 45;
const CONCURRENCY = 10;

/**
 * Analyse forward performance for a single stock after a scan date.
 * Returns null if data unavailable (caller should track for survivorship bias).
 */
async function analyzeOne(
  symbol:    string,
  name:      string,
  scanDate:  string,
  scanPrice: number,
): Promise<StockForwardPerformance | null> {
  try {
    const startMs  = Date.parse(scanDate) + 86400_000;
    const endMs    = startMs + FORWARD_WINDOW_DAYS * 86400_000;
    const startStr = new Date(startMs).toISOString().split('T')[0];
    const endStr   = new Date(endMs).toISOString().split('T')[0];

    const candles = await fetchCandlesRange(symbol, startStr, endStr, 8000);
    if (candles.length === 0) return null;

    const forwardCandles: ForwardCandle[] = candles.map(c => ({
      date: c.date, open: c.open, close: c.close, high: c.high, low: c.low,
    }));

    // 以訊號日收盤價（scanPrice）為基準的報酬率
    function retFromScan(idx: number): number | null {
      if (idx >= forwardCandles.length) return null;
      return +((forwardCandles[idx].close - scanPrice) / scanPrice * 100).toFixed(2);
    }

    // 以隔日開盤價為基準的報酬率（與 BacktestEngine 進場價一致）
    const nextOpenPrice = forwardCandles.length > 0 ? forwardCandles[0].open : null;
    function retFromOpen(idx: number): number | null {
      if (nextOpenPrice == null || nextOpenPrice <= 0) return null;
      if (idx >= forwardCandles.length) return null;
      return +((forwardCandles[idx].close - nextOpenPrice) / nextOpenPrice * 100).toFixed(2);
    }

    const openReturn: number | null = nextOpenPrice != null
      ? +((nextOpenPrice - scanPrice) / scanPrice * 100).toFixed(2)
      : null;

    let maxGain = 0;
    let maxLoss = 0;
    for (const c of forwardCandles) {
      const highRet = (c.high - scanPrice) / scanPrice * 100;
      const lowRet  = (c.low  - scanPrice) / scanPrice * 100;
      if (highRet > maxGain) maxGain = highRet;
      if (lowRet  < maxLoss) maxLoss = lowRet;
    }

    return {
      symbol,
      name,
      scanDate,
      scanPrice,
      openReturn,
      d1Return:  retFromScan(0),
      d2Return:  retFromScan(1),
      d3Return:  retFromScan(2),
      d4Return:  retFromScan(3),
      d5Return:  retFromScan(4),
      d10Return: retFromScan(9),
      d20Return: retFromScan(19),
      maxGain:   +maxGain.toFixed(2),
      maxLoss:   +maxLoss.toFixed(2),
      forwardCandles,
      // 以隔日開盤為基準（與 BacktestEngine 進場一致）
      nextOpenPrice,
      d1ReturnFromOpen:  retFromOpen(0),
      d5ReturnFromOpen:  retFromOpen(4),
      d10ReturnFromOpen: retFromOpen(9),
      d20ReturnFromOpen: retFromOpen(19),
    };
  } catch {
    return null;
  }
}

/**
 * Batch-analyze forward performance for a list of stocks.
 */
export async function analyzeForwardBatch(
  stocks:   Array<{ symbol: string; name: string; scanPrice: number }>,
  scanDate: string,
): Promise<StockForwardPerformance[]> {
  const results: StockForwardPerformance[] = [];

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = stocks.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(({ symbol, name, scanPrice }) =>
        analyzeOne(symbol, name, scanDate, scanPrice)
      )
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value);
    }
  }

  return results;
}

/**
 * Calculate summary statistics over a list of forward performances.
 */
export function calcBacktestSummary(
  perf: StockForwardPerformance[],
  horizon: 'open' | 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd10' | 'd20',
) {
  const key = (horizon === 'open' ? 'openReturn' : `${horizon}Return`) as keyof StockForwardPerformance;
  const returns = perf
    .map(p => p[key] as number | null)
    .filter((r): r is number => r !== null);

  if (returns.length === 0) return null;

  const wins    = returns.filter(r => r > 0).length;
  const avg     = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sorted  = [...returns].sort((a, b) => a - b);
  const median  = sorted[Math.floor(sorted.length / 2)];
  const maxGain = Math.max(...returns);
  const maxLoss = Math.min(...returns);

  return {
    count:    returns.length,
    wins,
    losses:   returns.length - wins,
    winRate:  +(wins / returns.length * 100).toFixed(1),
    avgReturn: +avg.toFixed(2),
    median:   +median.toFixed(2),
    maxGain:  +maxGain.toFixed(2),
    maxLoss:  +maxLoss.toFixed(2),
  };
}
