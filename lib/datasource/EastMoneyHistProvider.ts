/**
 * EastMoneyHistProvider — 東方財富歷史K線 Provider（A股 + 美股）
 *
 * API: https://push2his.eastmoney.com/api/qt/stock/kline/get
 *
 * secid 映射：
 *   上海 (6/9開頭): 1.{code}   深圳 (0/3開頭): 0.{code}
 *   美股 NASDAQ: 105.{ticker}  NYSE: 106.{ticker}  AMEX: 107.{ticker}
 *
 * klines CSV 格式（逗號分隔）：
 *   date, open, close, high, low, volume, amount, amplitude%, change%, changeAmt, turnover%
 *   注意：close 在 index[2]，high 在 index[3]（非標準 OHLC 順序）
 *
 * klt: 101=日K, 102=週K, 103=月K
 * fqt: 0=不復權, 1=前復權, 2=後復權
 */

import type { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { DataProvider } from './DataProvider';
import { globalCache } from './MemoryCache';
import { rateLimiter } from './UnifiedRateLimiter';

// ── 快取 TTL ──────────────────────────────────────────────────────────────────

const HISTORICAL_TTL = 24 * 60 * 60 * 1000; // 24h
const RECENT_TTL = 5 * 60 * 1000;           // 5min（歷史K線每天才變一次，即時報價有獨立快取）

// ── 美股市場代碼快取（ticker → 105/106/107） ─────────────────────────────────

const usMarketCodeCache = new Map<string, number>();

// ── 工具函數 ──────────────────────────────────────────────────────────────────

/** 從 symbol 提取 A 股純數字代碼，非 A 股回傳 null */
function extractCNCode(symbol: string): string | null {
  const m = symbol.match(/^(\d{6})\.(SS|SZ)$/i);
  return m ? m[1] : null;
}

/** 從 symbol 提取美股 ticker，非美股回傳 null */
function extractUSTicker(symbol: string): string | null {
  if (/^\d/.test(symbol)) return null;
  if (/\.(TW|TWO|SS|SZ)$/i.test(symbol)) return null;
  if (/^[A-Z]{1,5}(-[A-Z])?$/i.test(symbol)) return symbol.toUpperCase();
  return null;
}

/** A 股代碼 → secid */
function cnSecid(code: string): string {
  const first = code[0];
  // 6, 9 開頭 → 上海 (market=1)；0, 3 開頭 → 深圳 (market=0)
  return first === '6' || first === '9' ? `1.${code}` : `0.${code}`;
}

/** period 字串 → beg 日期 (YYYYMMDD) */
function periodToBeg(period: string): string {
  const match = period.match(/^(\d+)(y|mo?)$/);
  if (!match) return '20200101';
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const d = new Date();
  if (unit === 'y') d.setFullYear(d.getFullYear() - n);
  else d.setMonth(d.getMonth() - n);
  return d.toISOString().split('T')[0].replace(/-/g, '');
}

/** 解析東方財富 klines CSV 為 Candle[] */
function parseKlines(klines: string[], isCN: boolean): Candle[] {
  return klines
    .map((line) => {
      const f = line.split(',');
      if (f.length < 6) return null;
      // CSV: date, open, close, high, low, volume, ...
      const date = f[0]; // YYYY-MM-DD
      const open = parseFloat(f[1]);
      const close = parseFloat(f[2]); // 注意：close 在 [2]
      const high = parseFloat(f[3]);  // high 在 [3]
      const low = parseFloat(f[4]);
      let volume = parseInt(f[5], 10) || 0;

      if (isNaN(close) || close <= 0) return null;

      // A 股 volume 單位是「手」（1手=100股），轉為股
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

// ── 東方財富 K 線 fetch ──────────────────────────────────────────────────────

interface EMKlineResponse {
  data?: {
    code?: string;
    name?: string;
    klines?: string[];
  };
}

const EM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Referer': 'https://quote.eastmoney.com/',
};

async function fetchEMKlines(
  secid: string,
  beg: string,
  end: string,
  klt: number,
  fqt: number,
  timeoutMs = 15000,
): Promise<string[]> {
  // 統一限流
  await rateLimiter.acquire('eastmoney');

  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get` +
    `?secid=${secid}` +
    `&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=${klt}&fqt=${fqt}` +
    `&beg=${beg}&end=${end}`;

  const res = await fetch(url, {
    headers: EM_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    rateLimiter.reportError('eastmoney', res.status, `HTTP ${res.status}`);
    throw new Error(`EastMoney kline ${res.status}`);
  }

  rateLimiter.reportSuccess('eastmoney');
  const json = (await res.json()) as EMKlineResponse;
  return json.data?.klines ?? [];
}

/** 美股：嘗試 105/106/107，快取成功的 market code */
async function fetchUSKlines(
  ticker: string,
  beg: string,
  end: string,
  klt: number,
  fqt: number,
): Promise<string[]> {
  const cachedCode = usMarketCodeCache.get(ticker);
  if (cachedCode) {
    const klines = await fetchEMKlines(`${cachedCode}.${ticker}`, beg, end, klt, fqt);
    if (klines.length > 0) return klines;
  }

  // 嘗試順序：105 (NASDAQ) → 106 (NYSE) → 107 (AMEX)
  for (const mc of [105, 106, 107]) {
    if (mc === cachedCode) continue; // 已嘗試過
    try {
      const klines = await fetchEMKlines(`${mc}.${ticker}`, beg, end, klt, fqt);
      if (klines.length > 0) {
        usMarketCodeCache.set(ticker, mc);
        return klines;
      }
    } catch {
      continue;
    }
  }
  return [];
}

// ── interval → klt 映射 ─────────────────────────────────────────────────────

function intervalToKlt(interval?: string): number {
  switch (interval) {
    case '1m':  return 1;
    case '5m':  return 5;
    case '15m': return 15;
    case '30m': return 30;
    case '60m': return 60;
    case '1wk': return 102;
    case '1mo': return 103;
    default:    return 101; // 日K
  }
}

// ── DataProvider 實作 ─────────────────────────────────────────────────────────

export class EastMoneyHistProvider implements DataProvider {
  readonly name = 'EastMoney';

  async getHistoricalCandles(
    symbol: string,
    period = '2y',
    asOfDate?: string,
    interval?: string,
  ): Promise<CandleWithIndicators[]> {
    const cnCode = extractCNCode(symbol);
    const usTicker = extractUSTicker(symbol);
    if (!cnCode && !usTicker) return [];

    const klt = intervalToKlt(interval);
    const today = new Date().toISOString().split('T')[0];
    const isHistorical = asOfDate && asOfDate < today;
    const ttl = isHistorical ? HISTORICAL_TTL : RECENT_TTL;

    const cacheKey = `em:hist:${symbol}:${period}:${klt}:${asOfDate ?? 'live'}`;
    const cached = globalCache.get<CandleWithIndicators[]>(cacheKey);
    if (cached) return cached;

    // 分鐘 K 線東方財富只保留近期數據（1m 約 5 天，5m 約 20 天，15m+ 約 2 個月）
    // 強制使用較短的 beg 以確保有數據回傳
    const isMinuteKlt = klt >= 1 && klt <= 60;
    const effectivePeriod = isMinuteKlt ? '3m' : period;
    const beg = periodToBeg(effectivePeriod);
    const end = asOfDate
      ? asOfDate.replace(/-/g, '')
      : '20500101';

    // 前復權（fqt=1）用於歷史K線，保持均線連續
    const klines = cnCode
      ? await fetchEMKlines(cnSecid(cnCode), beg, end, klt, 1)
      : await fetchUSKlines(usTicker!, beg, end, klt, 1);

    const candles = parseKlines(klines, !!cnCode);

    const filtered = asOfDate
      ? candles.filter((c) => c.date <= asOfDate)
      : candles;

    if (filtered.length === 0) return [];

    const result = computeIndicators(filtered);
    globalCache.set(cacheKey, result, ttl);
    return result;
  }

  async getCandlesRange(
    symbol: string,
    startDate: string,
    endDate: string,
    interval?: string,
  ): Promise<Candle[]> {
    const cacheKey = `em:range:${symbol}:${startDate}:${endDate}`;
    const cached = globalCache.get<Candle[]>(cacheKey);
    if (cached) return cached;

    const cnCode = extractCNCode(symbol);
    const usTicker = extractUSTicker(symbol);
    if (!cnCode && !usTicker) return [];

    const klt = intervalToKlt(interval);
    const beg = startDate.replace(/-/g, '');
    const end = endDate.replace(/-/g, '');

    // 不復權（fqt=0）用於回測前向分析
    const klines = cnCode
      ? await fetchEMKlines(cnSecid(cnCode), beg, end, klt, 0)
      : await fetchUSKlines(usTicker!, beg, end, klt, 0);

    const result = parseKlines(klines, !!cnCode);

    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000)
      .toISOString()
      .split('T')[0];
    const isRecent = endDate >= twoDaysAgo;
    globalCache.set(cacheKey, result, isRecent ? RECENT_TTL : HISTORICAL_TTL);
    return result;
  }
}

/** 全域東方財富 provider 單例 */
export const eastMoneyHistProvider = new EastMoneyHistProvider();
