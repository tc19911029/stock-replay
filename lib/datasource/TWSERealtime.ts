/**
 * TWSERealtime.ts — 台灣 TWSE/TPEx 即時報價
 *
 * 從 TWSE OpenAPI (STOCK_DAY_ALL) 和 TPEx OpenAPI (tpex_mainboard_quotes)
 * 取得全市場當日即時 OHLCV，快取 30 秒。
 *
 * 用途：覆蓋 Yahoo Finance 延遲 15-20 分鐘的最後一根日 K，
 * 讓掃描和前端看到的數據接近即時。
 */

import { globalCache } from './MemoryCache';

export interface TWSEQuote {
  code: string;       // 純數字代碼，如 "2330"
  name: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;     // 成交量（張），mis.twse d.v 欄位已是張，直接使用
  previousClose?: number; // 昨收（由 Change 欄位推算），可用於驗證資料是否為今日
  date?: string;      // 資料日期 YYYY-MM-DD（由 API 的民國日期欄位解析）
}

const REALTIME_CACHE_KEY = 'twse:realtime:all';
const INTRADAY_CACHE_KEY = 'twse:realtime:intraday';
const REALTIME_TTL = 30 * 1000; // 30 秒

/** 正在進行中的 fetch promise（避免同時多次請求） */
let inflightPromise: Promise<Map<string, TWSEQuote>> | null = null;
let intradayInflight: Promise<Map<string, TWSEQuote>> | null = null;

/**
 * 取得全市場即時報價 Map（code → TWSEQuote）
 * 自動合併 TWSE 上市 + TPEx 上櫃
 */
export async function getTWSERealtime(): Promise<Map<string, TWSEQuote>> {
  const cached = globalCache.get<Map<string, TWSEQuote>>(REALTIME_CACHE_KEY);
  if (cached) return cached;

  // 防止併發重複請求
  if (inflightPromise) return inflightPromise;

  inflightPromise = fetchAllQuotes();
  try {
    const result = await inflightPromise;
    if (result.size > 0) {
      globalCache.set(REALTIME_CACHE_KEY, result, REALTIME_TTL);
    }
    return result;
  } finally {
    inflightPromise = null;
  }
}

/**
 * 取得單一股票的即時報價
 * @param code 純數字代碼（不含 .TW/.TWO）
 */
export async function getTWSEQuote(code: string): Promise<TWSEQuote | null> {
  const map = await getTWSERealtime();
  return map.get(code) ?? null;
}

// ── 內部實作 ──────────────────────────────────────────────────────────────────

interface TWSERawRow {
  Date?: string;    // 民國日期，如 "1150330"
  Code: string;
  Name: string;
  OpeningPrice: string;
  HighestPrice: string;
  LowestPrice: string;
  ClosingPrice: string;
  TradeVolume: string;
  Change?: string;  // 漲跌，如 "▲7.00", "▼3.50", " 0.00"
}

interface TPExRawRow {
  Date?: string;    // 民國日期，如 "1150330"
  SecuritiesCompanyCode: string;
  CompanyName: string;
  Open: string;
  High: string;
  Low: string;
  Close: string;
  TradingShares: string;
  Change?: string;  // 漲跌
}

/** 將民國日期 "YYYMMDD" 轉為 "YYYY-MM-DD" */
function parseROCDate(rocDate: string | undefined): string | undefined {
  if (!rocDate || rocDate.length < 7) return undefined;
  const year = parseInt(rocDate.slice(0, rocDate.length - 4)) + 1911;
  const month = rocDate.slice(-4, -2);
  const day = rocDate.slice(-2);
  const result = `${year}-${month}-${day}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : undefined;
}

function parseNum(s: string | undefined): number {
  if (!s) return 0;
  const n = parseFloat(s.replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

/** 解析 TWSE/TPEx 漲跌欄位，回傳帶正負號的數值（無法解析回傳 null） */
function parseChange(s: string | undefined): number | null {
  if (!s) return null;
  const stripped = s.replace(/[▲▼\s]/g, '').replace(/,/g, '');
  const n = parseFloat(stripped);
  if (isNaN(n)) return null;
  return s.includes('▼') ? -Math.abs(n) : Math.abs(n);
}

async function fetchAllQuotes(): Promise<Map<string, TWSEQuote>> {
  const map = new Map<string, TWSEQuote>();

  const [twseRes, tpexRes] = await Promise.allSettled([
    fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
      signal: AbortSignal.timeout(15000),
    }),
    fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes', {
      signal: AbortSignal.timeout(15000),
    }),
  ]);

  // ── TWSE 上市 ──
  if (twseRes.status === 'fulfilled' && twseRes.value.ok) {
    try {
      const data = await twseRes.value.json() as TWSERawRow[];
      for (const row of data) {
        if (!/^\d{4,5}$/.test(row.Code)) continue;
        const close = parseNum(row.ClosingPrice);
        if (close <= 0) continue; // 跳過無交易的股票
        const change = parseChange(row.Change);
        const previousClose = change !== null ? +(close - change).toFixed(2) : undefined;
        map.set(row.Code, {
          code: row.Code,
          name: row.Name?.trim() ?? row.Code,
          open: parseNum(row.OpeningPrice),
          high: parseNum(row.HighestPrice),
          low: parseNum(row.LowestPrice),
          close,
          volume: parseNum(row.TradeVolume),
          previousClose,
          date: parseROCDate(row.Date),
        });
      }
    } catch {
      // TWSE parse error, skip
    }
  }

  // ── TPEx 上櫃 ──
  if (tpexRes.status === 'fulfilled' && tpexRes.value.ok) {
    try {
      const data = await tpexRes.value.json() as TPExRawRow[];
      for (const row of data) {
        const code = row.SecuritiesCompanyCode;
        if (!/^\d{4,5}$/.test(code)) continue;
        const close = parseNum(row.Close);
        if (close <= 0) continue;
        const change = parseChange(row.Change);
        const previousClose = change !== null ? +(close - change).toFixed(2) : undefined;
        map.set(code, {
          code,
          name: row.CompanyName?.trim() ?? code,
          open: parseNum(row.Open),
          high: parseNum(row.High),
          low: parseNum(row.Low),
          close,
          volume: Math.round(parseNum(row.TradingShares) / 1000), // 股→張
          previousClose,
          date: parseROCDate(row.Date),
        });
      }
    } catch {
      // TPEx parse error, skip
    }
  }

  return map;
}

/**
 * 降級備援：使用 STOCK_DAY_ALL OpenAPI（比 mis.twse 穩定，但更新頻率較低）
 * 當 mis.twse 批量查詢失敗時使用，至少能拿到有數值的報價
 */
export async function getTWSEDailyAll(): Promise<Map<string, TWSEQuote>> {
  return fetchAllQuotes();
}

/**
 * 取得單一股票的盤中即時報價（優化版）
 * 先查 memory cache，命中就 O(1)；miss 則用 mis.twse.com.tw 單股查詢（< 200ms）
 * 避免為了 1 檔走圖而拉全市場 1900 檔報價
 */
export async function getTWSESingleIntraday(code: string): Promise<TWSEQuote | null> {
  // 先查全市場快取（若 cron 或掃描剛跑過，30s 內可命中）
  const cached = globalCache.get<Map<string, TWSEQuote>>(INTRADAY_CACHE_KEY);
  if (cached) return cached.get(code) ?? null;

  // 快取 miss：只查這一檔，不拉全市場
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  try {
    // 嘗試上市(tse)和上櫃(otc)兩種
    const exCh = `tse_${code}.tw|otc_${code}.tw`;
    const url = `http://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&_=${Date.now()}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    const d = json?.msgArray?.[0];
    if (!d) return null;
    const close = parseMisPrice(d.z) || parseMisPrice(d.l);
    if (close <= 0) return null;
    const prevClose = parseMisPrice(d.y);
    return {
      code: d.c || code,
      name: d.n?.trim() || code,
      open: parseMisPrice(d.o) || close,
      high: parseMisPrice(d.h) || close,
      low: parseMisPrice(d.l) || close,
      close,
      volume: parseInt((d.v || '0').replace(/,/g, ''), 10),
      previousClose: prevClose > 0 ? prevClose : undefined,
      date: today,
    };
  } catch {
    return null;
  }
}

// ── 盤中即時報價（mis.twse.com.tw）─────────────────────────────────────────

/**
 * 盤中即時報價 — 從 mis.twse.com.tw 批量取得全市場今日 OHLCV
 *
 * 與 getTWSERealtime() 的差別：
 *   - getTWSERealtime()     → STOCK_DAY_ALL（收盤統計，盤中回傳昨天數據）
 *   - getTWSERealtimeIntraday() → mis.twse.com.tw（真正的盤中即時報價）
 *
 * 步驟：
 *   1. 先用 STOCK_DAY_ALL / TPEx 取全市場代碼清單（區分上市/上櫃）
 *   2. 再用 mis.twse.com.tw 批量查詢即時 OHLCV
 *
 * 快取 30 秒，防止併發重複請求。
 */
export async function getTWSERealtimeIntraday(): Promise<Map<string, TWSEQuote>> {
  const cached = globalCache.get<Map<string, TWSEQuote>>(INTRADAY_CACHE_KEY);
  if (cached) return cached;

  if (intradayInflight) return intradayInflight;

  intradayInflight = fetchIntradayQuotes();
  try {
    const result = await intradayInflight;
    if (result.size > 0) {
      globalCache.set(INTRADAY_CACHE_KEY, result, REALTIME_TTL);
    }
    return result;
  } finally {
    intradayInflight = null;
  }
}

function parseMisPrice(s: string | undefined): number {
  if (!s || s === '-') return 0;
  const v = parseFloat(s);
  return isNaN(v) ? 0 : v;
}

const MIS_BATCH_SIZE = 80;     // 每次查詢的股票數量上限（mis.twse 實測 100 可用、200 失敗）
const MIS_CONCURRENCY = 4;     // 並行請求數（避免 rate limit）

async function fetchIntradayQuotes(): Promise<Map<string, TWSEQuote>> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const map = new Map<string, TWSEQuote>();

  // ── Step 1: 取全市場代碼清單（區分上市/上櫃）──
  const [twseRes, tpexRes] = await Promise.allSettled([
    fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
      signal: AbortSignal.timeout(10000),
    }),
    fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes', {
      signal: AbortSignal.timeout(10000),
    }),
  ]);

  const tseCodes: string[] = [];
  const otcCodes: string[] = [];

  if (twseRes.status === 'fulfilled' && twseRes.value.ok) {
    try {
      const data = await twseRes.value.json() as TWSERawRow[];
      for (const row of data) {
        if (/^\d{4,5}$/.test(row.Code)) tseCodes.push(row.Code);
      }
    } catch { /* parse error */ }
  }

  if (tpexRes.status === 'fulfilled' && tpexRes.value.ok) {
    try {
      const data = await tpexRes.value.json() as TPExRawRow[];
      for (const row of data) {
        if (/^\d{4,5}$/.test(row.SecuritiesCompanyCode)) otcCodes.push(row.SecuritiesCompanyCode);
      }
    } catch { /* parse error */ }
  }

  if (tseCodes.length === 0 && otcCodes.length === 0) {
    console.warn('[TWSERealtimeIntraday] 無法取得代碼清單，fallback 到 STOCK_DAY_ALL');
    return fetchAllQuotes(); // 降級回 STOCK_DAY_ALL
  }

  // ── Step 2: 批量查詢 mis.twse.com.tw ──
  async function fetchMisBatch(codes: string[], exchange: 'tse' | 'otc'): Promise<void> {
    try {
      const exCh = codes.map(c => `${exchange}_${c}.tw`).join('|');
      const url = `http://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&_=${Date.now()}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      });
      const json = await res.json();
      for (const d of json?.msgArray ?? []) {
        const code = d.c;
        if (!code) continue;
        const close = parseMisPrice(d.z) || parseMisPrice(d.l); // 最新成交 or 最低價 fallback
        if (close <= 0) continue; // 今日無交易
        const prevClose = parseMisPrice(d.y);
        map.set(code, {
          code,
          name: d.n?.trim() || code,
          open:  parseMisPrice(d.o) || close,
          high:  parseMisPrice(d.h) || close,
          low:   parseMisPrice(d.l) || close,
          close,
          volume: parseInt((d.v || '0').replace(/,/g, ''), 10), // mis.twse d.v 已是張
          previousClose: prevClose > 0 ? prevClose : undefined,
          date: today, // 確實是今天的即時數據
        });
      }
    } catch (err) {
      // 單批次失敗不影響其他批次，但記錄日誌方便排查
      console.warn(`[TWSERealtimeIntraday] ${exchange} 批次失敗 (${codes.length} 檔):`, String(err));
    }
  }

  async function batchFetch(codes: string[], exchange: 'tse' | 'otc'): Promise<void> {
    for (let i = 0; i < codes.length; i += MIS_BATCH_SIZE * MIS_CONCURRENCY) {
      const promises: Promise<void>[] = [];
      for (let j = i; j < Math.min(i + MIS_BATCH_SIZE * MIS_CONCURRENCY, codes.length); j += MIS_BATCH_SIZE) {
        promises.push(fetchMisBatch(codes.slice(j, j + MIS_BATCH_SIZE), exchange));
      }
      await Promise.allSettled(promises);
    }
  }

  // 上市 + 上櫃 並行
  await Promise.allSettled([
    batchFetch(tseCodes, 'tse'),
    batchFetch(otcCodes, 'otc'),
  ]);

  console.info(`[TWSERealtimeIntraday] 取得 ${map.size} 筆即時報價 (TSE:${tseCodes.length} OTC:${otcCodes.length})`);
  return map;
}
