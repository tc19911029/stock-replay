/**
 * FugleProvider — 富果 API 台股即時報價 + 分鐘 K 線
 *
 * API 文檔: https://developer.fugle.tw/docs/data/http-api/intraday/candles/
 * 免費版限制: 60 次/分 REST, 5 檔 WebSocket
 *
 * 基本 URL: https://api.fugle.tw/marketdata/v1.0/stock
 * 認證方式: X-API-KEY header
 *
 * 分鐘 K 線:
 *   GET /intraday/candles/{symbol}?timeframe={1|3|5|10|15|30|60}
 *
 * 即時報價:
 *   GET /intraday/quote/{symbol}
 */

import { globalCache } from './MemoryCache';
import { rateLimiter } from './UnifiedRateLimiter';
import type { Candle } from '@/types';

const FUGLE_BASE = 'https://api.fugle.tw/marketdata/v1.0/stock';
const INTRADAY_TTL = 30 * 1000;   // 30 秒快取（分鐘K盤中更新頻繁）
const HISTORICAL_TTL = 5 * 60 * 1000; // 5 分鐘快取（歷史分鐘K）
const QUOTE_TTL = 15 * 1000;      // 15 秒快取（即時報價）

function getApiKey(): string | null {
  return process.env.FUGLE_API_KEY ?? null;
}

function fugleHeaders(): Record<string, string> {
  const key = getApiKey();
  if (!key) throw new Error('FUGLE_API_KEY 環境變數未設定');
  return {
    'X-API-KEY': key,
    'Accept': 'application/json',
  };
}

// ── 分鐘 K 線 ──────────────────────────────────────────────────────────────────

/** Fugle timeframe 映射：我們的 interval → Fugle timeframe 參數 */
function intervalToFugleTimeframe(interval: string): string | null {
  const map: Record<string, string> = {
    '1m': '1', '3m': '3', '5m': '5', '10m': '10',
    '15m': '15', '30m': '30', '60m': '60',
  };
  return map[interval] ?? null;
}

export interface FugleCandleData {
  date: string;     // ISO 8601 timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  average: number;
}

interface FugleCandlesResponse {
  date: string;
  type: string;
  exchange: string;
  market: string;
  symbol: string;
  timeframe: string;
  data: FugleCandleData[];
}

/**
 * 取得台股分鐘 K 線（Fugle API）
 * @param symbol 台股代碼（純數字，如 "2330"）
 * @param interval 時間框架 "1m" | "3m" | "5m" | "10m" | "15m" | "30m" | "60m"
 */
export async function getFugleIntradayCandles(
  symbol: string,
  interval: string,
): Promise<Candle[]> {
  const timeframe = intervalToFugleTimeframe(interval);
  if (!timeframe) return [];

  const cacheKey = `fugle:candles:${symbol}:${interval}`;
  const cached = globalCache.get<Candle[]>(cacheKey);
  if (cached) return cached;

  try {
    await rateLimiter.acquire('fugle');
    const url = `${FUGLE_BASE}/intraday/candles/${symbol}?timeframe=${timeframe}`;
    const res = await fetch(url, {
      headers: fugleHeaders(),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      rateLimiter.reportError('fugle', res.status);
      if (res.status === 401 || res.status === 403) {
        console.warn('[Fugle] API Key 無效或過期');
      }
      return [];
    }
    rateLimiter.reportSuccess('fugle');

    const json = (await res.json()) as FugleCandlesResponse;
    const candles: Candle[] = (json.data ?? [])
      .filter(d => d.close > 0)
      .map(d => ({
        // Fugle 回傳 ISO 時間戳，轉為 "YYYY-MM-DD HH:mm" 格式
        date: d.date.replace('T', ' ').slice(0, 16),
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volume,
      }));

    if (candles.length > 0) {
      globalCache.set(cacheKey, candles, INTRADAY_TTL);
    }
    return candles;
  } catch (err) {
    console.warn('[Fugle] candles error:', err);
    return [];
  }
}

/**
 * 計算 period 對應的 from/to 日期（台北時間）
 * period: '5d' | '60d' | '6mo' | '1y' | ...
 */
function periodToTWDateRange(period: string): { from: string; to: string } {
  const calDays: Record<string, number> = {
    '5d': 7, '10d': 14, '20d': 30, '60d': 90,
    '6mo': 185, '1y': 370, '2y': 740,
  };
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(d);
  const now = new Date();
  const to = fmt(now);

  // 嘗試從 calDays 查表，否則 parse n+unit
  let days = calDays[period];
  if (days == null) {
    const m = period.match(/^(\d+)(d|mo?|y)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      const unit = m[2];
      if (unit === 'y') days = n * 365;
      else if (unit === 'mo' || unit === 'm') days = n * 30;
      else days = n; // 'd'
    } else {
      days = 7;
    }
  }
  const fromDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: fmt(fromDate), to };
}

/**
 * 取得台股歷史分鐘 K 線（Fugle Historical API）
 * 支援多天資料；intraday API 只有當日，此函式適用於回顧走圖。
 * @param symbol 台股代碼（純數字，如 "2330"）
 * @param interval 時間框架 "1m" | "5m" | "15m" | "30m" | "60m"
 * @param period 資料範圍 "5d" | "60d" | "6mo" 等
 */
export async function getFugleHistoricalMinuteCandles(
  symbol: string,
  interval: string,
  period = '5d',
): Promise<Candle[]> {
  const timeframe = intervalToFugleTimeframe(interval);
  if (!timeframe) return [];

  const { from, to } = periodToTWDateRange(period);
  const cacheKey = `fugle:hist:${symbol}:${interval}:${from}`;
  const cached = globalCache.get<Candle[]>(cacheKey);
  if (cached) return cached;

  try {
    await rateLimiter.acquire('fugle');
    const url = `${FUGLE_BASE}/historical/candles/${symbol}?timeframe=${timeframe}&from=${from}&to=${to}`;
    const res = await fetch(url, {
      headers: fugleHeaders(),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      rateLimiter.reportError('fugle', res.status);
      if (res.status === 401 || res.status === 403) {
        console.warn('[Fugle] historical API 未授權，可能需要付費方案');
      }
      return [];
    }
    rateLimiter.reportSuccess('fugle');

    const json = (await res.json()) as FugleCandlesResponse;
    const candles: Candle[] = (json.data ?? [])
      .filter(d => d.close > 0)
      .map(d => ({
        date: d.date.replace('T', ' ').slice(0, 16),
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volume,
      }));

    if (candles.length > 0) {
      globalCache.set(cacheKey, candles, HISTORICAL_TTL);
    }
    return candles;
  } catch (err) {
    console.warn('[Fugle] historical candles error:', err);
    return [];
  }
}

// ── 即時報價 ──────────────────────────────────────────────────────────────────

export interface FugleQuote {
  code: string;
  name: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  date?: string;
  prevClose?: number;
  changePercent?: number;
}

interface FugleQuoteResponse {
  date: string;
  type: string;
  exchange: string;
  market: string;
  symbol: string;
  name: string;
  referencePrice?: number;
  previousClose?: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  lastPrice: number;
  lastSize: number;
  total?: {
    tradeValue: number;
    tradeVolume: number;
    tradeVolumeAtBid: number;
    tradeVolumeAtAsk: number;
    transaction: number;
    time: number;
  };
  change: number;
  changePercent: number;
  lastUpdated: string;
}

/**
 * 取得台股單一個股即時報價（Fugle API）
 * @param symbol 台股代碼（純數字，如 "2330"）
 */
export async function getFugleQuote(symbol: string): Promise<FugleQuote | null> {
  const cacheKey = `fugle:quote:${symbol}`;
  const cached = globalCache.get<FugleQuote>(cacheKey);
  if (cached) return cached;

  try {
    await rateLimiter.acquire('fugle');
    const url = `${FUGLE_BASE}/intraday/quote/${symbol}`;
    const res = await fetch(url, {
      headers: fugleHeaders(),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      rateLimiter.reportError('fugle', res.status);
      return null;
    }
    rateLimiter.reportSuccess('fugle');

    const json = (await res.json()) as FugleQuoteResponse;

    // close 優先用 lastPrice（即時成交價）；若為 0/缺則用 closePrice（盤後官方收盤）
    // 注意 closePrice 不是昨收（previousClose / referencePrice 才是），所以 fallback 安全
    const close =
      json.lastPrice && json.lastPrice > 0 ? json.lastPrice
      : json.closePrice && json.closePrice > 0 ? json.closePrice
      : 0;
    const prev = json.previousClose ?? json.referencePrice ?? 0;

    // 鎖漲停／鎖跌停防呆：close === previousClose 但 high 已觸漲停（或 low 已觸跌停）
    // 這種「假裝沒漲跌」的 quote 用了會在下游被當 0% 排除（同 mis.twse 原 bug 模式）
    // TW 漲跌停 10%（ETF 例外但 Fugle 也會有正確 high/low），用 9.5% 容忍 lower-bound
    const isLockedFakeZero =
      prev > 0 && close > 0 &&
      Math.abs(close - prev) < 0.001 &&
      ((json.highPrice ?? 0) > prev * 1.095 || (json.lowPrice ?? Infinity) < prev * 0.905);
    if (isLockedFakeZero) {
      console.warn(
        `[Fugle] ${symbol} 可疑 quote 捨棄：close=${close} 等於 prev=${prev} 但 high=${json.highPrice} low=${json.lowPrice} 已觸漲跌停`,
      );
      return null;
    }

    const quote: FugleQuote = {
      code: json.symbol,
      name: json.name ?? json.symbol,
      open: json.openPrice ?? 0,
      high: json.highPrice ?? 0,
      low: json.lowPrice ?? 0,
      close,
      volume: json.total?.tradeVolume ?? 0,
      date: json.date,
      prevClose: prev > 0 ? prev : undefined,
      changePercent: json.changePercent,
    };

    if (quote.close > 0) {
      globalCache.set(cacheKey, quote, QUOTE_TTL);
    }
    return quote;
  } catch (err) {
    console.warn('[Fugle] quote error:', err);
    return null;
  }
}

/** 檢查 Fugle API Key 是否已設定 */
export function isFugleAvailable(): boolean {
  return !!getApiKey();
}
