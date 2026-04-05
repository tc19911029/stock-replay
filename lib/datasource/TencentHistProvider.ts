/**
 * TencentHistProvider — 騰訊財經歷史K線 Provider（備援，A股 + 美股）
 *
 * API: https://web.ifzq.gtimg.cn/appstock/app/fqkline/get
 *
 * 股票代碼格式：
 *   A股上海: sh600519    A股深圳: sz000858
 *   美股: usAAPL
 *
 * 每次最多 640 筆，需分段抓取長期資料。
 *
 * qfqday 陣列格式：[date, open, close, high, low, volume]
 * 注意：close 在 index[2]，high 在 index[3]（非標準 OHLC 順序）
 */

import type { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { DataProvider } from './DataProvider';
import { globalCache } from './MemoryCache';
import { aggregateCandles } from './aggregateCandles';
import { rateLimiter } from './UnifiedRateLimiter';

// ── 快取 TTL ──────────────────────────────────────────────────────────────────

const HISTORICAL_TTL = 24 * 60 * 60 * 1000;
const RECENT_TTL = 5 * 60 * 1000;           // 5min（歷史K線每天才變一次，即時報價有獨立快取）

// ── 工具函數 ──────────────────────────────────────────────────────────────────

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

/** A 股代碼 → 騰訊格式 (sh/sz prefix) */
function cnTencentCode(code: string): string {
  return (code[0] === '6' || code[0] === '9') ? `sh${code}` : `sz${code}`;
}

/** 美股 ticker → 騰訊格式候選列表 (需嘗試 .OQ 和 .N) */
function usTencentCandidates(ticker: string): string[] {
  // 騰訊用 . 代替 -（如 BRK-B → BRK.B）
  const t = ticker.replace(/-/g, '.');
  return [`us${t}.OQ`, `us${t}.N`];
}

/** 美股交易所快取（ticker → .OQ 或 .N） */
const usTencentExchangeCache = new Map<string, string>();

/** period 字串 → 起始日期 YYYY-MM-DD */
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

// ── Tencent K 線 fetch ──────────────────────────────────────────────────────

type TencentKlineEntry = [string, string, string, string, string, string];

interface TencentResponse {
  code: number;
  data?: Record<string, {
    qfqday?: TencentKlineEntry[];
    day?: TencentKlineEntry[];
  }>;
}

function parseEntries(entries: TencentKlineEntry[], isCN: boolean): Candle[] {
  return entries
    .map((row) => {
      const date = row[0]; // YYYY-MM-DD
      const open = parseFloat(row[1]);
      const close = parseFloat(row[2]); // close 在 [2]
      const high = parseFloat(row[3]);  // high 在 [3]
      const low = parseFloat(row[4]);
      let volume = parseInt(row[5], 10) || 0;

      if (isNaN(close) || close <= 0) return null;

      // A 股 volume 單位不確定（有時是手，有時已轉換），
      // 騰訊 API 的 volume 通常是「手」
      if (isCN) volume = volume * 100;

      return {
        date,
        open: +open.toFixed(2),
        high: +high.toFixed(2),
        low: +low.toFixed(2),
        close: +close.toFixed(2),
        volume,
      };
    })
    .filter((c): c is Candle => c !== null);
}

/**
 * 騰訊每次最多 640 筆。長期資料需分段：
 * 先抓 startDate~中間日期，再抓 中間日期~endDate，合併去重。
 */
async function fetchTencentKlines(
  code: string,
  startDate: string,
  endDate: string,
  isCN: boolean,
  maxRecords = 640,
): Promise<Candle[]> {
  // 統一限流
  await rateLimiter.acquire('tencent');

  const url =
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get` +
    `?param=${code},day,${startDate},${endDate},${maxRecords},qfq`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) {
      rateLimiter.reportError('tencent', res.status);
      return [];
    }
    rateLimiter.reportSuccess('tencent');

    const json = (await res.json()) as TencentResponse;
    if (json.code !== 0 || !json.data) return [];

    // 資料在 json.data[code].qfqday 或 json.data[code].day
    // key 可能是 code 本身，也可能需要遍歷 data 找到第一個有效 entry
    const stockData = json.data[code] ?? Object.values(json.data)[0];
    if (!stockData) return [];

    const entries = stockData.qfqday ?? stockData.day ?? [];
    return parseEntries(entries as TencentKlineEntry[], isCN);
  } catch {
    return [];
  }
}

/** 分段抓取 — 超過 640 天時分兩段 */
async function fetchAllTencentKlines(
  code: string,
  startDate: string,
  endDate: string,
  isCN: boolean,
): Promise<Candle[]> {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  const daysDiff = (end - start) / 86400_000;

  if (daysDiff <= 500) {
    // 單次可取完
    return fetchTencentKlines(code, startDate, endDate, isCN);
  }

  // 分段：前半 + 後半
  const mid = new Date(start + (end - start) / 2)
    .toISOString()
    .split('T')[0];

  const [part1, part2] = await Promise.all([
    fetchTencentKlines(code, startDate, mid, isCN),
    fetchTencentKlines(code, mid, endDate, isCN),
  ]);

  // 合併去重
  const all = [...part1, ...part2];
  const seen = new Set<string>();
  return all
    .filter((c) => {
      if (seen.has(c.date)) return false;
      seen.add(c.date);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── 美股：嘗試 .OQ / .N 交易所 ──────────────────────────────────────────────

async function fetchUSKlinesFromTencent(
  ticker: string,
  startDate: string,
  endDate: string,
): Promise<Candle[]> {
  // 檢查快取的交易所
  const cachedExchange = usTencentExchangeCache.get(ticker);
  if (cachedExchange) {
    const candles = await fetchAllTencentKlines(cachedExchange, startDate, endDate, false);
    if (candles.length > 0) return candles;
  }

  // 嘗試各交易所
  for (const candidate of usTencentCandidates(ticker)) {
    if (candidate === cachedExchange) continue;
    const candles = await fetchAllTencentKlines(candidate, startDate, endDate, false);
    if (candles.length > 0) {
      usTencentExchangeCache.set(ticker, candidate);
      return candles;
    }
  }
  return [];
}

// ── DataProvider 實作 ─────────────────────────────────────────────────────────

export class TencentHistProvider implements DataProvider {
  readonly name = 'Tencent Finance';

  async getHistoricalCandles(
    symbol: string,
    period = '2y',
    asOfDate?: string,
    interval?: string,
  ): Promise<CandleWithIndicators[]> {
    const cnCode = extractCNCode(symbol);
    const usTicker = extractUSTicker(symbol);
    if (!cnCode && !usTicker) return [];

    const isCN = !!cnCode;

    const today = new Date().toISOString().split('T')[0];
    const isHistorical = asOfDate && asOfDate < today;
    const ttl = isHistorical ? HISTORICAL_TTL : RECENT_TTL;

    const cacheKey = `tencent:hist:${symbol}:${period}:${interval ?? '1d'}:${asOfDate ?? 'live'}`;
    const cached = globalCache.get<CandleWithIndicators[]>(cacheKey);
    if (cached) return cached;

    const startDate = periodToStart(period);
    const endDate = asOfDate ?? today;

    let dailyCandles: Candle[];
    if (isCN) {
      dailyCandles = await fetchAllTencentKlines(cnTencentCode(cnCode!), startDate, endDate, true);
    } else {
      dailyCandles = await fetchUSKlinesFromTencent(usTicker!, startDate, endDate);
    }

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
    const cacheKey = `tencent:range:${symbol}:${startDate}:${endDate}`;
    const cached = globalCache.get<Candle[]>(cacheKey);
    if (cached) return cached;

    const cnCode = extractCNCode(symbol);
    const usTicker = extractUSTicker(symbol);
    if (!cnCode && !usTicker) return [];

    const isCN = !!cnCode;

    let result: Candle[];
    if (isCN) {
      result = await fetchAllTencentKlines(cnTencentCode(cnCode!), startDate, endDate, true);
    } else {
      result = await fetchUSKlinesFromTencent(usTicker!, startDate, endDate);
    }

    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000)
      .toISOString()
      .split('T')[0];
    const isRecent = endDate >= twoDaysAgo;
    globalCache.set(cacheKey, result, isRecent ? RECENT_TTL : HISTORICAL_TTL);
    return result;
  }
}

/** 全域騰訊 provider 單例 */
export const tencentHistProvider = new TencentHistProvider();
