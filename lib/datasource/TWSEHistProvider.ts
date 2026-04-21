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

/**
 * 拉單月 TWSE K 棒。
 *
 * 語義區分：
 *   - 成功有資料 → return Candle[]（長度 > 0）
 *   - 該月合法無交易日（新股未上市/停牌整月）→ return []（stat=OK 但 data 為空，或 stat 明確標註無資料）
 *   - API 失敗（HTTP error、timeout、JSON parse、限流）→ throw，讓 caller 決定 retry
 */
async function fetchTWSEMonth(code: string, dateStr: string): Promise<Candle[]> {
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateStr}&stockNo=${code}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; rockstock/2.0)' },
  });
  if (!res.ok) throw new Error(`TWSE HTTP ${res.status} (${code} ${dateStr})`);
  const json = (await res.json()) as TWSEResponse;
  // stat 非 OK 不一定是 API 失敗；「很抱歉，沒有符合條件的資料!」屬於合法空月
  if (json.stat && json.stat !== 'OK') {
    if (/沒有符合|無資料/.test(json.stat)) return [];
    throw new Error(`TWSE stat=${json.stat} (${code} ${dateStr})`);
  }
  if (!json.data) return [];

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

/** 拉單月 TPEx K 棒，語義同 fetchTWSEMonth：API 失敗一律 throw */
async function fetchTPExMonth(code: string, dateStr: string): Promise<Candle[]> {
  // dateStr 格式：20260401 → 轉為 2026/04/01
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const formattedDate = `${year}/${month}/01`;

  const url =
    `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock` +
    `?date=${formattedDate}&code=${code}&response=json`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    },
  });
  if (!res.ok) throw new Error(`TPEx HTTP ${res.status} (${code} ${dateStr})`);
  const json = (await res.json()) as TPExNewResponse;
  if (json.stat && json.stat !== 'ok') {
    // TPEx 新端點無資料時 stat 可能為 'no-data' 之類；視為合法空月
    if (/no.?data|沒有|無資料/i.test(json.stat)) return [];
    throw new Error(`TPEx stat=${json.stat} (${code} ${dateStr})`);
  }
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
}

// ── 批次抓取多月份（含限流） ──────────────────────────────────────────────────

/**
 * 批次抓取多月份（含限流 + retry）。
 *
 * 每月獨立 try：成功累積、失敗進 retry 隊列。最多 2 次 retry（等 2s、4s 退避）。
 * 全部嘗試完仍失敗的月份 log warn 但不擋整體 — caller（writeCandleFile）會 merge
 * 舊檔保留既有日期，下一輪 cron 會透過 backfill queue 再補。
 *
 * 相較舊版 try/catch 吞錯回 []：現在單月失敗會被看見、被 retry、最終失敗會被 log。
 */
async function fetchMonths(
  code: string,
  months: number,
  otc: boolean,
): Promise<Candle[]> {
  const now = new Date();
  const fetcher = otc ? fetchTPExMonth : fetchTWSEMonth;

  // 建立月份列表
  const dateStrs: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    dateStrs.push(
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`,
    );
  }

  // 分批抓取：
  // TWSE 限流嚴格，每批 3 個月並行，間隔 2 秒
  // TPEx 較寬鬆，每批 4 個月，間隔 1 秒
  const BATCH_SIZE = otc ? 4 : 3;
  const DELAY_MS = otc ? 1000 : 2000;
  const allCandles: Candle[] = [];

  const runBatch = async (queue: string[], label: string): Promise<string[]> => {
    const stillFailing: { ds: string; err: string }[] = [];
    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
      const batch = queue.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map((ds) => fetcher(code, ds)),
      );
      settled.forEach((r, idx) => {
        const ds = batch[idx];
        if (r.status === 'fulfilled') {
          allCandles.push(...r.value);
        } else {
          stillFailing.push({ ds, err: String(r.reason?.message ?? r.reason) });
        }
      });
      if (i + BATCH_SIZE < queue.length) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    }
    if (stillFailing.length > 0) {
      console.warn(
        `[TWSEHist] ${label} ${code}: ${stillFailing.length}/${queue.length} months failed`,
        stillFailing.slice(0, 3),
      );
    }
    return stillFailing.map((f) => f.ds);
  };

  // Pass 1
  let retryQueue = await runBatch(dateStrs, 'initial');

  // Retry pass 2（等 2s）
  if (retryQueue.length > 0) {
    await new Promise((r) => setTimeout(r, 2000));
    retryQueue = await runBatch(retryQueue, 'retry-1');
  }

  // Retry pass 3（等 4s）
  if (retryQueue.length > 0) {
    await new Promise((r) => setTimeout(r, 4000));
    retryQueue = await runBatch(retryQueue, 'retry-2');
  }

  if (retryQueue.length > 0) {
    console.error(
      `[TWSEHist] ${code}: ${retryQueue.length} months PERMANENTLY missing after retries`,
      retryQueue,
    );
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
