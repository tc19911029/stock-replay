/**
 * TWSEHistProvider — 台股歷史K線 Provider（證交所 + 櫃買中心 OpenAPI）
 *
 * 上市股：https://www.twse.com.tw/exchangeReport/STOCK_DAY
 * 上櫃股：https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php
 *
 * 每次只能取一個月，需循環抓取。TWSE 有限流（~3 秒間隔）。
 */

import type { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { DataProvider } from './DataProvider';
import { globalCache } from './MemoryCache';
import { aggregateCandles } from './aggregateCandles';

// ── 快取 TTL ──────────────────────────────────────────────────────────────────

const HISTORICAL_TTL = 24 * 60 * 60 * 1000; // 24h
const RECENT_TTL = 5 * 60 * 1000;           // 5min（歷史K線每天才變一次，即時報價有獨立快取）

// ── 工具函數 ──────────────────────────────────────────────────────────────────

/** ROC 日期 "115/03/28" → "2026-03-28" */
function parseROCDate(s: string): string | null {
  const parts = s.split('/');
  if (parts.length !== 3) return null;
  const year = parseInt(parts[0], 10) + 1911;
  return `${year}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
}

/** 去逗號後 parseFloat */
function num(s: string): number {
  return parseFloat(s.replace(/,/g, ''));
}

/** period 字串轉月數 */
function periodToMonths(period: string): number {
  const match = period.match(/^(\d+)(y|mo?)$/);
  if (!match) return 24; // default 2y
  const n = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'y') return n * 12 + 2; // extra buffer
  return n + 1;
}

/** 判斷是否為上櫃股（5 位數字 or .TWO） */
function isOTC(symbol: string): boolean {
  const code = symbol.replace(/\.(TW|TWO)$/i, '');
  return /\.TWO$/i.test(symbol) || code.length === 5;
}

/** 提取純數字代碼 */
function extractCode(symbol: string): string {
  return symbol.replace(/\.(TW|TWO)$/i, '');
}

// ── TWSE 上市股 fetch（單月） ─────────────────────────────────────────────────

type TWSERow = [string, string, string, string, string, string, string, string, string];

interface TWSEResponse {
  stat?: string;
  data?: TWSERow[];
}

async function fetchTWSEMonth(code: string, dateStr: string): Promise<Candle[]> {
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateStr}&stockNo=${code}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; rockstock/2.0)' },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as TWSEResponse;
    if (json.stat !== 'OK' || !json.data) return [];

    return json.data
      .map((row) => {
        const date = parseROCDate(row[0]);
        if (!date) return null;
        const open = num(row[3]);
        const high = num(row[4]);
        const low = num(row[5]);
        const close = num(row[6]);
        // TWSE volume 是股數，除以 1000 轉張
        const volume = Math.round(num(row[1]) / 1000);
        if (isNaN(close) || close <= 0) return null;
        return { date, open, high, low, close, volume };
      })
      .filter((c): c is Candle => c !== null);
  } catch {
    return [];
  }
}

// ── TPEx 上櫃股 fetch（單月） ─────────────────────────────────────────────────
// 新端點：https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock
// 回傳格式：tables[0].data = [[日期, 成交張數, 成交仟元, 開盤, 最高, 最低, 收盤, 漲跌, 筆數]]

interface TPExNewResponse {
  stat?: string;
  tables?: {
    data?: string[][];
  }[];
}

async function fetchTPExMonth(code: string, dateStr: string): Promise<Candle[]> {
  // dateStr 格式：20260401 → 轉為 2026/04/01
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const formattedDate = `${year}/${month}/01`;

  const url =
    `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock` +
    `?date=${formattedDate}&code=${code}&response=json`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as TPExNewResponse;
    if (json.stat !== 'ok') return [];
    const rows = json.tables?.[0]?.data;
    if (!rows || rows.length === 0) return [];

    return rows
      .map((row) => {
        // 新格式: [日期(115/04/01), 成交張數, 成交仟元, 開盤, 最高, 最低, 收盤, 漲跌, 筆數]
        const date = parseROCDate(row[0]);
        if (!date) return null;
        const open = num(row[3]);
        const high = num(row[4]);
        const low = num(row[5]);
        const close = num(row[6]);
        const volume = num(row[1]); // 已經是張數，不需轉換
        if (isNaN(close) || close <= 0) return null;
        return { date, open, high, low, close, volume };
      })
      .filter((c): c is Candle => c !== null);
  } catch {
    return [];
  }
}

// ── FinMind fallback（TPEx Cloudflare 403 / TWSE rate-limit 時用） ───────────
// FinMind dataset=TaiwanStockPrice 上市/上櫃通用，stock_id 不帶後綴
// Trading_Volume 單位是「股」，除以 1000 轉張
const FINMIND_TOKEN = process.env.FINMIND_API_TOKEN ?? '';

interface FinMindPriceRow {
  date: string;
  Trading_Volume: number;
  open: number;
  max: number;
  min: number;
  close: number;
}

async function fetchFinMindMonth(code: string, dateStr: string): Promise<Candle[]> {
  // dateStr 格式：YYYYMM01 → start=YYYY-MM-01, end=YYYY-MM-末日
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
  const url =
    `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice` +
    `&data_id=${code}&start_date=${startDate}&end_date=${endDate}` +
    (FINMIND_TOKEN ? `&token=${FINMIND_TOKEN}` : '');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const json = (await res.json()) as { status: number; data?: FinMindPriceRow[] };
    if (json.status !== 200 || !json.data) return [];
    return json.data
      .map((r) => {
        if (!r.date || isNaN(r.close) || r.close <= 0) return null;
        return {
          date: r.date,
          open: r.open,
          high: r.max,
          low: r.min,
          close: r.close,
          volume: Math.round(r.Trading_Volume / 1000),
        };
      })
      .filter((c): c is Candle => c !== null);
  } catch {
    return [];
  }
}

// Yahoo fallback：FinMind 配額耗盡時的最後一道防線
async function fetchYahooMonth(symbol: string, dateStr: string): Promise<Candle[]> {
  // 用 unix 秒數定 period1/period2 為當月 1 號 ~ 下月 1 號（含 Yahoo 的 UTC 偏移容忍）
  const year = parseInt(dateStr.substring(0, 4));
  const month = parseInt(dateStr.substring(4, 6));
  const period1 = Math.floor(Date.UTC(year, month - 1, 1) / 1000);
  const period2 = Math.floor(Date.UTC(year, month, 1) / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
    `?interval=1d&period1=${period1}&period2=${period2}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      chart?: { result?: { timestamp?: number[]; indicators: { quote: { open: (number|null)[]; high: (number|null)[]; low: (number|null)[]; close: (number|null)[]; volume: (number|null)[] }[] } }[] };
    };
    const r = json.chart?.result?.[0];
    const ts = r?.timestamp;
    if (!ts || ts.length === 0) return [];
    const q = r.indicators.quote[0];
    const out: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q.close[i];
      if (close == null || close <= 0) continue;
      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      out.push({
        date,
        open: q.open[i] ?? close,
        high: q.high[i] ?? close,
        low: q.low[i] ?? close,
        close,
        volume: Math.round((q.volume[i] ?? 0) / 1000),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** TWSE 主 → FinMind → Yahoo 三層 fallback：上市股單月抓取 */
async function fetchTWSEMonthWithFallback(code: string, dateStr: string): Promise<Candle[]> {
  const primary = await fetchTWSEMonth(code, dateStr);
  if (primary.length > 0) return primary;
  const finmind = await fetchFinMindMonth(code, dateStr);
  if (finmind.length > 0) return finmind;
  return fetchYahooMonth(`${code}.TW`, dateStr);
}

/** TPEx 主 → FinMind → Yahoo 三層 fallback：上櫃股單月抓取（TPEx 被 Cloudflare 403 時不致斷流） */
async function fetchTPExMonthWithFallback(code: string, dateStr: string): Promise<Candle[]> {
  const primary = await fetchTPExMonth(code, dateStr);
  if (primary.length > 0) return primary;
  const finmind = await fetchFinMindMonth(code, dateStr);
  if (finmind.length > 0) return finmind;
  return fetchYahooMonth(`${code}.TWO`, dateStr);
}

// ── 批次抓取多月份（含限流） ──────────────────────────────────────────────────

async function fetchMonths(
  code: string,
  months: number,
  otc: boolean,
): Promise<Candle[]> {
  const now = new Date();
  const fetcher = otc ? fetchTPExMonthWithFallback : fetchTWSEMonthWithFallback;

  // 建立月份列表
  const dateStrs: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    dateStrs.push(
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`,
    );
  }

  // 分批抓取：
  // TWSE 限流嚴格，每批 3 個月並行，間隔 2 秒（比之前快）
  // TPEx 較寬鬆，每批 4 個月，間隔 1 秒
  const BATCH_SIZE = otc ? 4 : 3;
  const DELAY_MS = otc ? 1000 : 2000;
  const allCandles: Candle[] = [];

  for (let i = 0; i < dateStrs.length; i += BATCH_SIZE) {
    const batch = dateStrs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((ds) => fetcher(code, ds)));
    allCandles.push(...results.flat());

    // 不是最後一批就等待
    if (i + BATCH_SIZE < dateStrs.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  // 去重 + 排序（oldest first）
  const seen = new Set<string>();
  return allCandles
    .filter((c) => {
      if (seen.has(c.date)) return false;
      seen.add(c.date);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── DataProvider 實作 ─────────────────────────────────────────────────────────

export class TWSEHistProvider implements DataProvider {
  readonly name = 'TWSE/TPEx';

  async getHistoricalCandles(
    symbol: string,
    period = '2y',
    asOfDate?: string,
    interval?: string,
  ): Promise<CandleWithIndicators[]> {
    const code = extractCode(symbol);
    const otc = isOTC(symbol);
    const months = periodToMonths(period);

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const isHistorical = asOfDate && asOfDate < today;
    const ttl = isHistorical ? HISTORICAL_TTL : RECENT_TTL;

    const cacheKey = `twse:hist:${code}:${period}:${interval ?? '1d'}:${asOfDate ?? 'live'}`;
    const cached = globalCache.get<CandleWithIndicators[]>(cacheKey);
    if (cached) return cached;

    const dailyCandles = await fetchMonths(code, months, otc);
    const filtered = asOfDate
      ? dailyCandles.filter((c) => c.date <= asOfDate)
      : dailyCandles;

    if (filtered.length === 0) return [];

    const candles = aggregateCandles(filtered, interval);
    const result = computeIndicators(candles);
    globalCache.set(cacheKey, result, ttl);
    return result;
  }

  async getCandlesRange(
    symbol: string,
    startDate: string,
    endDate: string,
  ): Promise<Candle[]> {
    const cacheKey = `twse:range:${symbol}:${startDate}:${endDate}`;
    const cached = globalCache.get<Candle[]>(cacheKey);
    if (cached) return cached;

    const code = extractCode(symbol);
    const otc = isOTC(symbol);

    // 計算需要抓幾個月
    const start = new Date(startDate);
    const end = new Date(endDate);
    const monthsDiff =
      (end.getFullYear() - start.getFullYear()) * 12 +
      (end.getMonth() - start.getMonth()) +
      2; // extra buffer

    const allCandles = await fetchMonths(code, monthsDiff, otc);
    const filtered = allCandles.filter(
      (c) => c.date >= startDate && c.date <= endDate,
    );

    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000)
      .toISOString()
      .split('T')[0];
    const isRecent = endDate >= twoDaysAgo;
    globalCache.set(cacheKey, filtered, isRecent ? RECENT_TTL : HISTORICAL_TTL);
    return filtered;
  }
}

/** 全域 TWSE provider 單例 */
export const twseHistProvider = new TWSEHistProvider();
