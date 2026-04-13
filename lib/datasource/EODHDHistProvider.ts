/**
 * EODHDHistProvider — EODHD 全球歷史 K 線 Provider
 *
 * 支援台股 (.TW/.TWO) 和陸股 (.SS/.SZ)，一次 API call 取全部歷史。
 * API: https://eodhd.com/api/eod/{TICKER}?api_token={TOKEN}&fmt=json&from={date}&to={date}
 *
 * Ticker 轉換（EODHD 格式）：
 *   .TW  → .TW  （台股上市，不變）
 *   .TWO → .TWO （台股上櫃，不變）
 *   .SS  → .SHG （上海）
 *   .SZ  → .SHE （深圳）
 */

import type { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { DataProvider } from './DataProvider';
import { globalCache } from './MemoryCache';
import { rateLimiter } from './UnifiedRateLimiter';

const EODHD_BASE = 'https://eodhd.com/api/eod';

const HISTORICAL_TTL = 24 * 60 * 60 * 1000; // 24h
const RECENT_TTL = 5 * 60 * 1000;           // 5min

// ── Ticker 轉換 ───────────────────────────────────────────────────────────────

function toEODHDTicker(symbol: string): string {
  if (symbol.endsWith('.SS')) return symbol.slice(0, -3) + '.SHG';
  if (symbol.endsWith('.SZ')) return symbol.slice(0, -3) + '.SHE';
  return symbol; // .TW / .TWO 維持不變
}

// ── period → 起始日期 ─────────────────────────────────────────────────────────

function periodToStartDate(period: string): string {
  const match = period.match(/^(\d+)(y|mo?)$/);
  const d = new Date();
  if (!match) { d.setFullYear(d.getFullYear() - 2); return d.toISOString().split('T')[0]; }
  const n = parseInt(match[1], 10);
  if (match[2] === 'y') d.setFullYear(d.getFullYear() - n);
  else d.setMonth(d.getMonth() - n);
  return d.toISOString().split('T')[0];
}

// ── 型別 ──────────────────────────────────────────────────────────────────────

interface EODHDRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjusted_close: number;
  volume: number;
}

// ── 抓取邏輯 ──────────────────────────────────────────────────────────────────

async function fetchEODHDCandles(
  eodhTicker: string,
  from: string,
  to: string,
): Promise<Candle[]> {
  const EODHD_TOKEN = process.env.EODHD_API_TOKEN ?? '';
  if (!EODHD_TOKEN) throw new Error('EODHD_API_TOKEN not configured');

  const url =
    `${EODHD_BASE}/${encodeURIComponent(eodhTicker)}` +
    `?api_token=${EODHD_TOKEN}&fmt=json&from=${from}&to=${to}`;

  // P1B: 限流保護 — 等待 token 後才發請求
  await rateLimiter.acquire('eodhd');

  const res = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { Accept: 'application/json' },
  });

  if (res.status === 401 || res.status === 403) {
    rateLimiter.reportError('eodhd', res.status, 'auth failed');
    throw new Error(`EODHD auth failed: ${res.status}`);
  }
  if (res.status === 402) {
    rateLimiter.reportError('eodhd', 402, 'quota exhausted');
    throw new Error('EODHD 402: quota exhausted — 配額耗盡，退避 1 小時');
  }
  if (!res.ok) {
    rateLimiter.reportError('eodhd', res.status);
    throw new Error(`EODHD ${res.status}`);
  }

  rateLimiter.reportSuccess('eodhd');

  const text = await res.text();
  // EODHD returns plain text "Ticker Not Found." for unknown tickers
  if (!text.startsWith('[')) return [];

  const rows = JSON.parse(text) as EODHDRow[];
  if (!Array.isArray(rows) || rows.length === 0) return [];

  return rows
    .filter(r => r.open > 0 && r.high > 0 && r.low > 0 && r.close > 0)
    .map(r => ({
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
}

// ── Provider 實作 ─────────────────────────────────────────────────────────────

class EODHDHistProvider implements DataProvider {
  readonly name = 'EODHD';

  async getHistoricalCandles(
    symbol: string,
    period = '2y',
    asOfDate?: string,
  ): Promise<CandleWithIndicators[]> {
    const cacheKey = `eodhd:hist:${symbol}:${period}:${asOfDate ?? 'live'}`;
    const ttl = asOfDate ? HISTORICAL_TTL : RECENT_TTL;
    const cached = globalCache.get<CandleWithIndicators[]>(cacheKey);
    if (cached) return cached;

    const eodhTicker = toEODHDTicker(symbol);
    const from = periodToStartDate(period);
    const to = asOfDate ?? new Date().toISOString().split('T')[0];

    const candles = await fetchEODHDCandles(eodhTicker, from, to);
    if (candles.length === 0) return [];

    const result = computeIndicators(candles);
    globalCache.set(cacheKey, result, ttl);
    return result;
  }

  async getCandlesRange(
    symbol: string,
    startDate: string,
    endDate: string,
  ): Promise<Candle[]> {
    const cacheKey = `eodhd:range:${symbol}:${startDate}:${endDate}`;
    const cached = globalCache.get<Candle[]>(cacheKey);
    if (cached) return cached;

    const eodhTicker = toEODHDTicker(symbol);
    const candles = await fetchEODHDCandles(eodhTicker, startDate, endDate);
    globalCache.set(cacheKey, candles, HISTORICAL_TTL);
    return candles;
  }
}

export const eodhdHistProvider = new EODHDHistProvider();
