/**
 * MultiMarketProvider — 多市場路由器 + 備援 + 盤前時段保護
 *
 * 走圖路由（單檔速度優先，EODHD 降為備援）：
 *   台股 (.TW/.TWO) → FinMind → EODHD → TWSE/TPEx
 *   陸股 (.SS/.SZ)  → 東方財富 → 騰訊財經 → EODHD
 *   美股            → 騰訊財經 → 東方財富
 *
 * EODHD（付費）的配額留給 cron 批量下載，走圖只有 1-3 檔用免費 API 即可。
 *
 * 即時覆蓋僅在「盤中」時段套用，盤前/盤後不會產生虛假的今日K棒。
 *
 * 效能優化：
 * - 歷史K線與即時報價並行取得
 * - inflight dedup 避免重複並發請求
 * - 超時競賽：主 provider 5 秒未回應則同時啟動備援
 */

import type { Candle, CandleWithIndicators } from '@/types';
import { DataProvider } from './DataProvider';
import { twseHistProvider } from './TWSEHistProvider';
import { finmindHistProvider } from './FinMindHistProvider';
import { eastMoneyHistProvider } from './EastMoneyHistProvider';
import { tencentHistProvider } from './TencentHistProvider';
import { eodhdHistProvider } from './EODHDHistProvider';
import { getTWSEQuote, getTWSERealtimeIntraday } from './TWSERealtime';
import { getEastMoneyQuote, getUSStockQuote } from './EastMoneyRealtime';

// ── 市場判斷 ──────────────────────────────────────────────────────────────────

function extractTWCode(symbol: string): string | null {
  const m = symbol.match(/^(\d{4,5})\.(TW|TWO)$/i);
  return m ? m[1] : null;
}

function extractCNCode(symbol: string): string | null {
  const m = symbol.match(/^(\d{6})\.(SS|SZ)$/i);
  return m ? m[1] : null;
}

function extractUSTicker(symbol: string): string | null {
  if (/^\d/.test(symbol)) return null;
  if (/\.(TW|TWO|SS|SZ)$/i.test(symbol)) return null;
  if (/^[A-Z]{1,5}(-[A-Z])?$/i.test(symbol)) return symbol.toUpperCase();
  return null;
}

type Market = 'TW' | 'CN' | 'US' | null;

function detectMarket(symbol: string): Market {
  if (extractTWCode(symbol)) return 'TW';
  if (extractCNCode(symbol)) return 'CN';
  if (extractUSTicker(symbol)) return 'US';
  return null;
}

// ── 盤中時段判斷 ──────────────────────────────────────────────────────────────

function getAsiaDateStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

function getUSDateStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** 取得指定時區的當前小時和分鐘 */
function getLocalTime(tz: string): { hour: number; min: number; dow: number } {
  const now = new Date();
  const parts = now.toLocaleString('en-US', {
    timeZone: tz, hour12: false,
    hour: '2-digit', minute: '2-digit',
  }).split(':');
  const hour = parseInt(parts[0], 10);
  const min = parseInt(parts[1], 10);
  const DOW_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
  const dow = DOW_MAP[dayStr] ?? 1;
  return { hour, min, dow };
}

/** 台股是否在盤中（09:00–13:30，週一～五） */
function isTWMarketOpen(): boolean {
  const { hour, min, dow } = getLocalTime('Asia/Taipei');
  if (dow === 0 || dow === 6) return false;
  const timeMin = hour * 60 + min;
  return timeMin >= 540 && timeMin <= 810; // 09:00 ~ 13:30
}

/** A 股是否在盤中（09:15–15:00，週一～五） */
function isCNMarketOpen(): boolean {
  const { hour, min, dow } = getLocalTime('Asia/Shanghai');
  if (dow === 0 || dow === 6) return false;
  const timeMin = hour * 60 + min;
  return timeMin >= 555 && timeMin <= 900; // 09:15 ~ 15:00
}

/** 美股是否在盤中（09:30–16:00 ET，週一～五） */
function isUSMarketOpen(): boolean {
  const { hour, min, dow } = getLocalTime('America/New_York');
  if (dow === 0 || dow === 6) return false;
  const timeMin = hour * 60 + min;
  return timeMin >= 570 && timeMin <= 960; // 09:30 ~ 16:00
}

// ── 即時報價覆蓋（僅盤中） ──────────────────────────────────────────────────

export async function overlayRealtimeQuote(
  symbol: string,
  candles: Candle[],
  dateRangeStart?: string,
  dateRangeEnd?: string,
): Promise<void> {
  const twCode = extractTWCode(symbol);
  const cnCode = extractCNCode(symbol);
  const usTicker = extractUSTicker(symbol);
  if (!twCode && !cnCode && !usTicker) return;

  // 盤前/盤後不覆蓋 — 避免用昨日報價產生虛假的今日K棒
  if (twCode && !isTWMarketOpen()) return;
  if (cnCode && !isCNMarketOpen()) return;
  if (usTicker && !isUSMarketOpen()) return;

  try {
    const quote = twCode
      ? ((await getTWSERealtimeIntraday()).get(twCode) ?? await getTWSEQuote(twCode))
      : cnCode
        ? await getEastMoneyQuote(cnCode)
        : await getUSStockQuote(usTicker!);
    if (!quote || quote.close <= 0) return;

    const todayStr = usTicker ? getUSDateStr() : getAsiaDateStr();

    // getCandlesRange 模式：檢查 today 在範圍內
    if (dateRangeStart && dateRangeEnd) {
      if (todayStr < dateRangeStart || todayStr > dateRangeEnd) return;
    }

    // 過期資料防護：若 quote 帶日期且不是今天，跳過
    const quoteDate = 'date' in quote ? (quote.date as string | undefined) : undefined;
    if (quoteDate && quoteDate !== todayStr) return;

    const lastCandle = candles[candles.length - 1];
    if (!lastCandle) return;

    if (lastCandle.date === todayStr) {
      lastCandle.open = quote.open;
      lastCandle.high = quote.high;
      lastCandle.low = quote.low;
      lastCandle.close = quote.close;
      lastCandle.volume = quote.volume;
    } else if (lastCandle.date < todayStr) {
      candles.push({
        date: todayStr,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.close,
        volume: quote.volume,
      });
    }
  } catch {
    // 即時報價失敗不影響主流程
  }
}

// ── 預取即時報價（盤中時提前啟動，與歷史資料並行） ────────────────────────────

interface QuoteResult {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  date?: string;
}

function prefetchRealtimeQuote(
  symbol: string,
  isHistorical: boolean,
): Promise<QuoteResult | null> | null {
  if (isHistorical) return null;

  const twCode = extractTWCode(symbol);
  const cnCode = extractCNCode(symbol);
  const usTicker = extractUSTicker(symbol);

  if (twCode && isTWMarketOpen()) {
    return getTWSERealtimeIntraday()
      .then((map) => (map.get(twCode) as QuoteResult | undefined) ?? getTWSEQuote(twCode))
      .catch(() => null);
  }
  if (cnCode && isCNMarketOpen()) {
    return getEastMoneyQuote(cnCode).catch(() => null);
  }
  if (usTicker && isUSMarketOpen()) {
    return getUSStockQuote(usTicker).catch(() => null);
  }
  return null;
}

/** 將預取的報價合併到 K 線陣列 */
function applyPrefetchedQuote(
  symbol: string,
  candles: Candle[],
  quote: QuoteResult | null,
): void {
  if (!quote || quote.close <= 0 || candles.length === 0) return;

  const usTicker = extractUSTicker(symbol);
  const todayStr = usTicker ? getUSDateStr() : getAsiaDateStr();

  const quoteDate = quote.date;
  if (quoteDate && quoteDate !== todayStr) return;

  const lastCandle = candles[candles.length - 1];
  if (lastCandle.date === todayStr) {
    lastCandle.open = quote.open;
    lastCandle.high = quote.high;
    lastCandle.low = quote.low;
    lastCandle.close = quote.close;
    lastCandle.volume = quote.volume;
  } else if (lastCandle.date < todayStr) {
    candles.push({
      date: todayStr,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      close: quote.close,
      volume: quote.volume,
    });
  }
}

// ── 超時競賽：主 provider 超時則同時啟動備援 ─────────────────────────────────

const RACE_TIMEOUT_MS = 5000; // 主 provider 5 秒內未回應就啟動備援

async function tryProvidersWithRacing<T>(
  providers: { name: string; fn: () => Promise<T[]> }[],
): Promise<T[]> {
  const { isCircuitOpen, recordSuccess, recordFailure } = await import('./circuitBreaker');

  // Filter out providers with open circuits
  const available = providers.filter(p => {
    if (isCircuitOpen(p.name)) {
      console.warn(`[MultiMarket] ${p.name} circuit open, skipping`);
      return false;
    }
    return true;
  });

  if (available.length === 0) {
    // All circuits open — try all as last resort
    console.warn('[MultiMarket] All circuits open, attempting all providers');
    available.push(...providers);
  }

  if (available.length === 1) {
    try {
      const result = await available[0].fn();
      recordSuccess(available[0].name);
      return result;
    } catch (err) {
      console.warn(`[MultiMarket] ${available[0].name} failed:`, err);
      recordFailure(available[0].name);
      return [];
    }
  }

  const primary = available[0];
  const fallbacks = available.slice(1);

  // 啟動主 provider
  const primaryPromise = primary.fn()
    .then((r) => { recordSuccess(primary.name); return r; })
    .catch((err) => {
      console.warn(`[MultiMarket] ${primary.name} failed:`, err);
      recordFailure(primary.name);
      return [] as T[];
    });

  // 競賽：主 provider 5 秒內回應 → 用主 provider；否則同時啟動備援
  const result = await Promise.race([
    primaryPromise.then((r) => (r.length > 0 ? r : null)),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), RACE_TIMEOUT_MS)),
  ]);

  if (result && result.length > 0) return result;

  // 主 provider 超時或回傳空 → 啟動備援，同時繼續等主 provider
  const fallbackPromises = fallbacks.map(({ name, fn }) =>
    fn()
      .then((r) => { recordSuccess(name); return r; })
      .catch((err) => {
        console.warn(`[MultiMarket] ${name} failed:`, err);
        recordFailure(name);
        return [] as T[];
      }),
  );

  // 等所有結果（主 provider + 備援），取第一個非空
  const allResults = await Promise.all([primaryPromise, ...fallbackPromises]);
  for (const r of allResults) {
    if (r.length > 0) return r;
  }
  return [];
}

// ── inflight 請求去重 ────────────────────────────────────────────────────────

const inflightHistorical = new Map<string, Promise<CandleWithIndicators[]>>();
const inflightRange = new Map<string, Promise<Candle[]>>();

// ── DataProvider 實作 ─────────────────────────────────────────────────────────

export class MultiMarketProvider implements DataProvider {
  readonly name = 'MultiMarket';

  async getHistoricalCandles(
    symbol: string,
    period = '2y',
    asOfDate?: string,
    interval?: string,
  ): Promise<CandleWithIndicators[]> {
    const market = detectMarket(symbol);
    if (!market) throw new Error(`無法辨識股票代號: ${symbol}`);

    // inflight dedup
    const dedupKey = `${symbol}:${period}:${asOfDate ?? ''}:${interval ?? ''}`;
    const inflight = inflightHistorical.get(dedupKey);
    if (inflight) return inflight;

    const promise = this._getHistoricalCandlesImpl(symbol, market, period, asOfDate, interval);
    inflightHistorical.set(dedupKey, promise);
    try {
      return await promise;
    } finally {
      inflightHistorical.delete(dedupKey);
    }
  }

  private async _getHistoricalCandlesImpl(
    symbol: string,
    market: Market,
    period: string,
    asOfDate?: string,
    interval?: string,
  ): Promise<CandleWithIndicators[]> {
    const today = new Date().toISOString().split('T')[0];
    const isHistorical = !!asOfDate && asOfDate < today;

    // 提前啟動即時報價（與歷史 K 線並行）
    const quotePromise = prefetchRealtimeQuote(symbol, isHistorical);

    let result: CandleWithIndicators[];

    // 分鐘級 interval：僅 EastMoney 支援（FinMind/TWSE/騰訊只有日K）
    const isMinuteInterval = ['1m', '5m', '15m', '30m', '60m'].includes(interval ?? '');

    if (market === 'TW') {
      // 走圖路由：FinMind 單檔快 → EODHD 備援 → TWSE 最後
      result = await tryProvidersWithRacing([
        {
          name: `FinMind ${symbol}`,
          fn: () => finmindHistProvider.getHistoricalCandles(symbol, period, asOfDate, interval),
        },
        {
          name: `EODHD ${symbol}`,
          fn: () => eodhdHistProvider.getHistoricalCandles(symbol, period, asOfDate),
        },
        {
          name: `TWSE ${symbol}`,
          fn: () => twseHistProvider.getHistoricalCandles(symbol, period, asOfDate, interval),
        },
      ]);
    } else if (isMinuteInterval) {
      // 分鐘 K 線只有 EastMoney 支援
      result = await tryProvidersWithRacing([
        {
          name: `EastMoney ${symbol}`,
          fn: () => eastMoneyHistProvider.getHistoricalCandles(symbol, period, asOfDate, interval),
        },
      ]);
    } else {
      // 陸股/美股走圖路由：EastMoney 單檔快 → Tencent 備援 → EODHD 最後
      result = await tryProvidersWithRacing([
        {
          name: `EastMoney ${symbol}`,
          fn: () => eastMoneyHistProvider.getHistoricalCandles(symbol, period, asOfDate, interval),
        },
        {
          name: `Tencent ${symbol}`,
          fn: () => tencentHistProvider.getHistoricalCandles(symbol, period, asOfDate, interval),
        },
        {
          name: `EODHD ${symbol}`,
          fn: () => eodhdHistProvider.getHistoricalCandles(symbol, period, asOfDate),
        },
      ]);
    }

    // 合併即時報價（已預取，不額外等待網路）
    if (result.length > 0 && quotePromise) {
      const quote = await quotePromise;
      applyPrefetchedQuote(symbol, result, quote);
    }

    // 資料品質檢查：移除 OHLCV 異常的 K 棒
    if (result.length > 0) {
      const { validateCandles } = await import('./validateCandles');
      const { candles: cleaned, removed, issues } = validateCandles(result);
      if (removed > 0) {
        console.warn(`[MultiMarket] ${symbol}: removed ${removed} invalid candles`, issues.slice(0, 5));
      }
      return cleaned;
    }

    return result;
  }

  async getCandlesRange(
    symbol: string,
    startDate: string,
    endDate: string,
  ): Promise<Candle[]> {
    const market = detectMarket(symbol);
    if (!market) throw new Error(`無法辨識股票代號: ${symbol}`);

    // inflight dedup
    const dedupKey = `range:${symbol}:${startDate}:${endDate}`;
    const inflight = inflightRange.get(dedupKey);
    if (inflight) return inflight;

    const promise = this._getCandlesRangeImpl(symbol, market, startDate, endDate);
    inflightRange.set(dedupKey, promise);
    try {
      return await promise;
    } finally {
      inflightRange.delete(dedupKey);
    }
  }

  private async _getCandlesRangeImpl(
    symbol: string,
    market: Market,
    startDate: string,
    endDate: string,
  ): Promise<Candle[]> {
    let result: Candle[];

    if (market === 'TW') {
      result = await tryProvidersWithRacing([
        {
          name: `FinMind range ${symbol}`,
          fn: () => finmindHistProvider.getCandlesRange(symbol, startDate, endDate),
        },
        {
          name: `EODHD range ${symbol}`,
          fn: () => eodhdHistProvider.getCandlesRange(symbol, startDate, endDate),
        },
        {
          name: `TWSE range ${symbol}`,
          fn: () => twseHistProvider.getCandlesRange(symbol, startDate, endDate),
        },
      ]);
    } else {
      result = await tryProvidersWithRacing([
        {
          name: `EastMoney range ${symbol}`,
          fn: () => eastMoneyHistProvider.getCandlesRange(symbol, startDate, endDate),
        },
        {
          name: `Tencent range ${symbol}`,
          fn: () => tencentHistProvider.getCandlesRange(symbol, startDate, endDate),
        },
        {
          name: `EODHD range ${symbol}`,
          fn: () => eodhdHistProvider.getCandlesRange(symbol, startDate, endDate),
        },
      ]);
    }

    // 即時覆蓋
    if (result.length > 0) {
      const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString().split('T')[0];
      if (endDate >= twoDaysAgo) {
        await overlayRealtimeQuote(symbol, result, startDate, endDate);
      }
    }

    return result;
  }
}

/** 全域多市場 provider 單例 — 取代 yahooProvider */
export const dataProvider = new MultiMarketProvider();
