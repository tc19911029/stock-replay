// lib/datasource/YahooDataProvider.ts
import { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { DataProvider } from './DataProvider';
import { globalCache } from './MemoryCache';
import { getTWSEQuote } from './TWSERealtime';

/** 從 symbol 提取台股純數字代碼，非台股回傳 null */
function extractTWCode(symbol: string): string | null {
  const m = symbol.match(/^(\d{4,5})\.(TW|TWO)$/i);
  return m ? m[1] : null;
}

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
};

// 歷史資料 TTL：24 小時（歷史資料不會變）
const HISTORICAL_TTL = 24 * 60 * 60 * 1000;
// 近期資料 TTL：5 分鐘（當天資料可能更新）
const RECENT_TTL = 1 * 60 * 1000;  // 盤中 1 分鐘快取（Yahoo 本身有 15-20 分鐘延遲）

/** 原始 OHLC，不套用除權息調整（用於跨日期區間比較，避免調整基準不同） */
function parseYahooCandlesRaw(json: unknown): Candle[] {
  const result = (json as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as {
    timestamp?: number[];
    indicators?: {
      quote?: { open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }[];
    };
  } | undefined;
  if (!result) return [];

  const timestamps: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!q) return [];

  return timestamps
    .map((ts, i) => {
      const o = q.open[i]; const h = q.high[i];
      const l = q.low[i];  const c = q.close[i];
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
}

function parseYahooCandles(json: unknown): Candle[] {
  const result = (json as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as {
    timestamp?: number[];
    indicators?: {
      quote?:    { open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }[];
      adjclose?: { adjclose: number[] }[];
    };
  } | undefined;
  if (!result) return [];

  const timestamps: number[] = result.timestamp ?? [];
  const q   = result.indicators?.quote?.[0];
  const adj = result.indicators?.adjclose?.[0]?.adjclose as number[] | undefined;
  if (!q) return [];

  return timestamps
    .map((ts, i) => {
      const o = q.open[i]; const h = q.high[i];
      const l = q.low[i];  const c = q.close[i];
      const v = q.volume[i];
      if (o == null || h == null || l == null || c == null || isNaN(o)) return null;

      // 除權息調整：用 adjclose / close 比例同步調整所有 OHLC
      // 確保均線、報酬率在除權息日前後連續，不產生假跳空
      const adjFactor = (adj && adj[i] != null && c > 0) ? adj[i] / c : 1;

      return {
        date:   new Date(ts * 1000).toISOString().split('T')[0],
        open:   +(o * adjFactor).toFixed(2),
        high:   +(h * adjFactor).toFixed(2),
        low:    +(l * adjFactor).toFixed(2),
        close:  +(c * adjFactor).toFixed(2),
        volume: v ?? 0,
      };
    })
    .filter((c): c is Candle => c != null);
}

/**
 * Yahoo Finance 資料提供者
 *
 * 實作 DataProvider 介面，包含：
 * - 自動快取（歷史資料 24h，近期資料 5min）
 * - asOfDate 嚴格防止未來資料洩漏
 * - 錯誤處理與 timeout
 */
export class YahooDataProvider implements DataProvider {
  readonly name = 'Yahoo Finance';

  async getHistoricalCandles(
    symbol: string,
    period = '1y',
    asOfDate?: string,
    timeoutMs = 20000,
  ): Promise<CandleWithIndicators[]> {
    // 判斷是否為歷史資料（可以用更長的快取）
    const today = new Date().toISOString().split('T')[0];
    const isHistorical = asOfDate && asOfDate < today;
    const ttl = isHistorical ? HISTORICAL_TTL : RECENT_TTL;

    const cacheKey = `yahoo:candles:${symbol}:${period}:${asOfDate ?? 'live'}`;
    const cached = globalCache.get<CandleWithIndicators[]>(cacheKey);
    if (cached) return cached;

    let url: string;
    if (asOfDate) {
      const endUnix   = Math.floor(new Date(asOfDate).getTime() / 1000) + 2 * 86400;
      const startUnix = endUnix - 400 * 86400;
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${startUnix}&period2=${endUnix}&includePrePost=false&events=div,split`;
    } else {
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${period}&includePrePost=false&events=div,split`;
    }

    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${symbol}`);

    const rawCandles = parseYahooCandles(await res.json());
    const filtered = asOfDate
      ? rawCandles.filter(c => c.date <= asOfDate)
      : rawCandles;

    // 台股即時報價覆蓋：用 TWSE/TPEx 即時 OHLCV 補上最新一根日 K
    const twCode = extractTWCode(symbol);
    if (twCode && !isHistorical && filtered.length > 0) {
      try {
        const quote = await getTWSEQuote(twCode);
        if (quote && quote.close > 0) {
          const todayStr = new Date(Date.now() + 8 * 3600_000).toISOString().split('T')[0];
          const lastCandle = filtered[filtered.length - 1];
          if (lastCandle.date === todayStr) {
            lastCandle.open   = quote.open;
            lastCandle.high   = quote.high;
            lastCandle.low    = quote.low;
            lastCandle.close  = quote.close;
            lastCandle.volume = quote.volume;
          } else if (lastCandle.date < todayStr) {
            filtered.push({
              date:   todayStr,
              open:   quote.open,
              high:   quote.high,
              low:    quote.low,
              close:  quote.close,
              volume: quote.volume,
            });
          }
        }
      } catch (e) {
        console.warn(`[YahooDataProvider] TWSE overlay failed for ${twCode}:`, e);
      }
    }

    const result = computeIndicators(filtered);
    globalCache.set(cacheKey, result, ttl);
    return result;
  }

  async getCandlesRange(
    symbol: string,
    startDate: string,
    endDate: string,
    timeoutMs = 8000,
  ): Promise<Candle[]> {
    const cacheKey = `yahoo:range:${symbol}:${startDate}:${endDate}`;
    const cached = globalCache.get<Candle[]>(cacheKey);
    if (cached) return cached;

    const startUnix = Math.floor(new Date(startDate).getTime() / 1000);
    const endUnix   = Math.floor(new Date(endDate).getTime()   / 1000) + 86400;

    // events=split only（不傳 div），避免 adjclose 因為股息而調整基準
    // getCandlesRange 用於前向績效計算，需要原始 OHLC 避免跨窗口調整基準不一致
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${startUnix}&period2=${endUnix}&includePrePost=false&events=split`;

    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${symbol}`);

    const result = parseYahooCandlesRaw(await res.json());

    // 台股即時報價覆蓋
    const twCode = extractTWCode(symbol);
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString().split('T')[0];
    const isRecent = endDate >= twoDaysAgo;

    if (twCode && isRecent && result.length > 0) {
      try {
        const quote = await getTWSEQuote(twCode);
        if (quote && quote.close > 0) {
          const todayStr = new Date(Date.now() + 8 * 3600_000).toISOString().split('T')[0];
          if (todayStr >= startDate && todayStr <= endDate) {
            const lastCandle = result[result.length - 1];
            if (lastCandle.date === todayStr) {
              lastCandle.open   = quote.open;
              lastCandle.high   = quote.high;
              lastCandle.low    = quote.low;
              lastCandle.close  = quote.close;
              lastCandle.volume = quote.volume;
            } else if (lastCandle.date < todayStr) {
              result.push({
                date:   todayStr,
                open:   quote.open,
                high:   quote.high,
                low:    quote.low,
                close:  quote.close,
                volume: quote.volume,
              });
            }
          }
        }
      } catch (e) {
        console.warn(`[YahooDataProvider] TWSE range overlay failed for ${twCode}:`, e);
      }
    }

    globalCache.set(cacheKey, result, isRecent ? RECENT_TTL : HISTORICAL_TTL);
    return result;
  }
}

/** 全域 Yahoo provider 單例 */
export const yahooProvider = new YahooDataProvider();
