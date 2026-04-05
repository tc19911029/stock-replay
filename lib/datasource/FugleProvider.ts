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
const INTRADAY_TTL = 30 * 1000;  // 30 秒快取（分鐘K盤中更新頻繁）
const QUOTE_TTL = 15 * 1000;     // 15 秒快取（即時報價）

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
}

interface FugleQuoteResponse {
  date: string;
  type: string;
  exchange: string;
  market: string;
  symbol: string;
  name: string;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  lastPrice: number;
  lastSize: number;
  totalVolume: number;
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

    const quote: FugleQuote = {
      code: json.symbol,
      name: json.name ?? json.symbol,
      open: json.openPrice ?? 0,
      high: json.highPrice ?? 0,
      low: json.lowPrice ?? 0,
      close: json.lastPrice ?? json.closePrice ?? 0,
      volume: json.totalVolume ?? 0,
      date: json.date,
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
