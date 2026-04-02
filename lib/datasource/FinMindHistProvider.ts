/**
 * FinMindHistProvider — FinMind 台股歷史K線 Provider（備援）
 *
 * API: https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice
 *
 * 優點：一次抓多年歷史、無限流問題、已有 token 基建
 * 限制：僅台股上市+上櫃、免費 300 req/hr
 *
 * 回傳欄位：date, stock_id, Trading_Volume, open, max, min, close
 * 注意：max/min 對應 high/low
 */

import type { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { DataProvider } from './DataProvider';
import { globalCache } from './MemoryCache';
import { aggregateCandles } from './aggregateCandles';

const FINMIND_BASE = 'https://api.finmindtrade.com/api/v4/data';
const FINMIND_TOKEN = process.env.FINMIND_API_TOKEN ?? '';

const HISTORICAL_TTL = 24 * 60 * 60 * 1000;
const RECENT_TTL = 5 * 60 * 1000;

// ── 熔斷器：402 後停止嘗試 1 小時 ────────────────────────────────────────────
let rateLimitedUntil = 0;

/** FinMind 是否可用（未被限流） */
export function isFinMindAvailable(): boolean {
  return Date.now() > rateLimitedUntil;
}

// ── FinMind 回傳型別 ─────────────────────────────────────────────────────────

interface FinMindPriceRow {
  date: string;          // "2026-04-01"
  stock_id: string;
  Trading_Volume: number; // 成交量（股）
  Trading_money: number;
  open: number;
  max: number;           // 最高
  min: number;           // 最低
  close: number;
  spread: number;
  Trading_turnover: number;
}

// ── period → start_date ──────────────────────────────────────────────────────

function periodToStart(period: string): string {
  const match = period.match(/^(\d+)(y|mo?)$/);
  if (!match) return '2020-01-01';
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const d = new Date();
  if (unit === 'y') d.setFullYear(d.getFullYear() - n);
  else d.setMonth(d.getMonth() - n);
  return d.toISOString().split('T')[0];
}

/** 提取純數字代碼 */
function extractCode(symbol: string): string {
  return symbol.replace(/\.(TW|TWO)$/i, '');
}

// ── 抓取邏輯 ─────────────────────────────────────────────────────────────────

async function fetchFinMindPrice(
  code: string,
  startDate: string,
  endDate?: string,
): Promise<Candle[]> {
  // 熔斷器：被限流時直接跳過
  if (!isFinMindAvailable()) {
    throw new Error('FinMind rate limited (circuit breaker open)');
  }

  const url = new URL(FINMIND_BASE);
  url.searchParams.set('dataset', 'TaiwanStockPrice');
  url.searchParams.set('data_id', code);
  url.searchParams.set('start_date', startDate);
  if (endDate) url.searchParams.set('end_date', endDate);
  if (FINMIND_TOKEN) url.searchParams.set('token', FINMIND_TOKEN);

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(20000),
    headers: { Accept: 'application/json' },
  });

  if (res.status === 402) {
    // 額度用完，啟動熔斷器 — 1 小時後重試
    rateLimitedUntil = Date.now() + 60 * 60 * 1000;
    console.warn('[FinMind] Rate limited (402). Circuit breaker open for 1 hour.');
    throw new Error('FinMind 402 rate limited');
  }

  if (!res.ok) throw new Error(`FinMind ${res.status}`);

  const json = (await res.json()) as { status: number; data: FinMindPriceRow[] };
  if (json.status !== 200 || !json.data) return [];

  return json.data
    .map((row) => {
      if (!row.close || row.close <= 0) return null;
      return {
        date: row.date,
        open: +row.open.toFixed(2),
        high: +row.max.toFixed(2),    // max → high
        low: +row.min.toFixed(2),     // min → low
        close: +row.close.toFixed(2),
        volume: Math.round(row.Trading_Volume / 1000), // 股→張
      };
    })
    .filter((c): c is Candle => c !== null);
}

// ── DataProvider 實作 ─────────────────────────────────────────────────────────

export class FinMindHistProvider implements DataProvider {
  readonly name = 'FinMind';

  async getHistoricalCandles(
    symbol: string,
    period = '2y',
    asOfDate?: string,
    interval?: string,
  ): Promise<CandleWithIndicators[]> {
    const code = extractCode(symbol);

    const today = new Date().toISOString().split('T')[0];
    const isHistorical = asOfDate && asOfDate < today;
    const ttl = isHistorical ? HISTORICAL_TTL : RECENT_TTL;

    const cacheKey = `finmind:hist:${code}:${period}:${interval ?? '1d'}:${asOfDate ?? 'live'}`;
    const cached = globalCache.get<CandleWithIndicators[]>(cacheKey);
    if (cached) return cached;

    const startDate = periodToStart(period);
    const endDate = asOfDate ?? today;

    const dailyCandles = await fetchFinMindPrice(code, startDate, endDate);
    if (dailyCandles.length === 0) return [];

    const candles = aggregateCandles(dailyCandles, interval);
    const result = computeIndicators(candles);
    globalCache.set(cacheKey, result, ttl);
    return result;
  }

  async getCandlesRange(
    symbol: string,
    startDate: string,
    endDate: string,
  ): Promise<Candle[]> {
    const cacheKey = `finmind:range:${symbol}:${startDate}:${endDate}`;
    const cached = globalCache.get<Candle[]>(cacheKey);
    if (cached) return cached;

    const code = extractCode(symbol);
    const result = await fetchFinMindPrice(code, startDate, endDate);

    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000)
      .toISOString()
      .split('T')[0];
    const isRecent = endDate >= twoDaysAgo;
    globalCache.set(cacheKey, result, isRecent ? RECENT_TTL : HISTORICAL_TTL);
    return result;
  }
}

export const finmindHistProvider = new FinMindHistProvider();
