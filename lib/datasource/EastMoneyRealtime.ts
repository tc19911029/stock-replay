/**
 * EastMoneyRealtime.ts — 東方財富即時報價（A 股 + 美股）
 *
 * 從東方財富 push2 API 取得即時 OHLCV，快取 30 秒。
 * 用途：覆蓋 Yahoo Finance 延遲 15-20 分鐘的最後一根日 K。
 *
 * 東方財富欄位對照：
 *   f12=代碼, f14=名稱, f17=開盤, f15=最高, f16=最低, f2=最新價,
 *   f5=成交量(手), f6=成交額
 *
 * 市場代碼：
 *   A 股: m:0+t:6(滬A主板), m:0+t:80(科創板), m:1+t:2(深A主板), m:1+t:23(創業板)
 *   美股: m:105(NASDAQ), m:106(NYSE), m:107(AMEX)
 */

import { globalCache } from './MemoryCache';

export interface EastMoneyQuote {
  code: string;       // A股: "600519", 美股: "AAPL"
  name: string;
  open: number;
  high: number;
  low: number;
  close: number;      // 最新價
  volume: number;     // 成交量（股）
  /** 昨收（A股從 f18 取得，美股可能無） */
  prevClose?: number;
}

// ── A 股 ──────────────────────────────────────────────────────────────────────

const CN_CACHE_KEY = 'eastmoney:cn:all';
const US_CACHE_KEY = 'eastmoney:us:all';
const REALTIME_TTL = 30 * 1000; // 30 秒

let cnInflight: Promise<Map<string, EastMoneyQuote>> | null = null;
let usInflight: Promise<Map<string, EastMoneyQuote>> | null = null;

/**
 * 取得全市場 A 股即時報價 Map（code → EastMoneyQuote）
 */
export async function getEastMoneyRealtime(): Promise<Map<string, EastMoneyQuote>> {
  const cached = globalCache.get<Map<string, EastMoneyQuote>>(CN_CACHE_KEY);
  if (cached) return cached;

  if (cnInflight) return cnInflight;

  cnInflight = fetchMarketQuotes('cn');
  try {
    const result = await cnInflight;
    if (result.size > 0) globalCache.set(CN_CACHE_KEY, result, REALTIME_TTL);
    return result;
  } finally {
    cnInflight = null;
  }
}

/**
 * 取得單一 A 股的即時報價
 * @param code 6 位純數字代碼（不含 .SS/.SZ）
 */
export async function getEastMoneyQuote(code: string): Promise<EastMoneyQuote | null> {
  const map = await getEastMoneyRealtime();
  return map.get(code) ?? null;
}

/**
 * 取得單一 A 股的盤中即時報價（優化版）
 * 先查 memory cache，命中就 O(1)；miss 則用 push2 API 單股查詢
 * 避免為了 1 檔走圖而拉全市場 4000 檔報價
 */
export async function getEastMoneySingleQuote(code: string): Promise<EastMoneyQuote | null> {
  // 先查全市場快取
  const cached = globalCache.get<Map<string, EastMoneyQuote>>(CN_CACHE_KEY);
  if (cached) return cached.get(code) ?? null;

  // 快取 miss：只查這一檔
  try {
    // 判斷市場：6/9 開頭 = 上海(m:1)，其他 = 深圳(m:0)
    const secId = code[0] === '6' || code[0] === '9' ? `1.${code}` : `0.${code}`;
    // push2 會 302 redirect 到 push2delay；同時帶 live (f2/f15-f17) 與 delay (f43-f60) 欄位，哪邊有資料就用哪邊
    const fields = 'f2,f5,f12,f14,f15,f16,f17,f43,f44,f45,f46,f47,f60';
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secId}&fields=${fields}&ut=fa5fd1943c7b386f172d6893dbfba10b`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const item = json?.data;
    if (!item) return null;

    // live 欄位優先；若 push2delay 回應則 f43-f60（分為單位，÷100 轉元）
    const hasLive = item.f2 != null && item.f2 > 0;
    const hasDelay = item.f43 != null && item.f43 > 0;
    if (!hasLive && !hasDelay) return null;

    const close = hasLive ? item.f2 : item.f43 / 100;
    const open  = hasLive
      ? (item.f17 != null && item.f17 > 0 ? item.f17 : item.f2)
      : (item.f46 != null && item.f46 > 0 ? item.f46 / 100 : close);
    const high  = hasLive
      ? (item.f15 != null && item.f15 > 0 ? item.f15 : item.f2)
      : (item.f44 != null && item.f44 > 0 ? item.f44 / 100 : close);
    const low   = hasLive
      ? (item.f16 != null && item.f16 > 0 ? item.f16 : item.f2)
      : (item.f45 != null && item.f45 > 0 ? item.f45 / 100 : close);
    const volume = (hasLive ? (item.f5 ?? 0) : (item.f47 ?? 0)) * 100; // f5/f47 單位為「手」；×100 轉為「股」
    const prevClose = item.f60 != null && item.f60 > 0 ? (hasLive ? item.f60 : item.f60 / 100) : undefined;

    return {
      code: item.f12 || code,
      name: (item.f14 && item.f14 !== '-') ? item.f14 : code,
      open,
      high,
      low,
      close,
      volume,
      prevClose,
    };
  } catch {
    return null;
  }
}

// ── 美股 ──────────────────────────────────────────────────────────────────────

/**
 * 取得美股即時報價 Map（ticker → EastMoneyQuote, 如 "AAPL"）
 */
export async function getUSStockRealtime(): Promise<Map<string, EastMoneyQuote>> {
  const cached = globalCache.get<Map<string, EastMoneyQuote>>(US_CACHE_KEY);
  if (cached) return cached;

  if (usInflight) return usInflight;

  usInflight = fetchMarketQuotes('us');
  try {
    const result = await usInflight;
    if (result.size > 0) globalCache.set(US_CACHE_KEY, result, REALTIME_TTL);
    return result;
  } finally {
    usInflight = null;
  }
}

/**
 * 取得單一美股的即時報價
 * @param ticker 美股 ticker（如 "AAPL", "TSLA"）
 */
export async function getUSStockQuote(ticker: string): Promise<EastMoneyQuote | null> {
  const map = await getUSStockRealtime();
  return map.get(ticker.toUpperCase()) ?? null;
}

// ── 內部實作 ──────────────────────────────────────────────────────────────────

interface EastMoneyItem {
  f2: number;   // 最新價
  f5: number;   // 成交量（手，A股1手=100股；美股1手=1股）
  f12: string;  // 代碼
  f14: string;  // 名稱
  f15: number;  // 最高
  f16: number;  // 最低
  f17: number;  // 開盤
  f18: number;  // 昨收
}

// A 股市場代碼（只含主板，排除創業板 m:1+t:23 和科創板 m:0+t:80）
const CN_FS = 'm:0+t:6,m:1+t:2';
// 美股市場代碼（NASDAQ + NYSE + AMEX）
const US_FS = 'm:105,m:106,m:107';

/**
 * 解析 API 回傳的單筆報價為 EastMoneyQuote
 */
function parseItem(item: EastMoneyItem, market: 'cn' | 'us'): EastMoneyQuote | null {
  const code = item.f12;
  if (!code || code === '-') return null;

  const close = item.f2;
  if (!close || close <= 0 || close === '-' as unknown as number) return null;

  if (market === 'cn') {
    if (!/^\d{6}$/.test(code)) return null;
    // 只保留主板：600/601/603/605(滬主板), 000/001/002/003(深主板)
    // 排除：創業板(300/301), 科創板(688), B股(200/900), 三板(4xx), 北交所(8xx)
    if (!/^(00[0-3]|60[0135])\d{3}$/.test(code)) return null;

    return {
      code,
      name: (item.f14 && item.f14 !== '-') ? item.f14 : code,
      open:   (item.f17 != null && item.f17 > 0) ? item.f17 : close,
      high:   (item.f15 != null && item.f15 > 0) ? item.f15 : close,
      low:    (item.f16 != null && item.f16 > 0) ? item.f16 : close,
      close,
      volume: (item.f5 ?? 0) * 100, // f5 單位為「手」(1手=100股)；×100 轉為「股」與 L1 歷史一致
      prevClose: (item.f18 != null && item.f18 > 0) ? item.f18 : undefined,
    };
  }

  // 美股
  return {
    code: code.toUpperCase(),
    name: (item.f14 && item.f14 !== '-') ? item.f14 : code,
    open:   (item.f17 != null && item.f17 > 0) ? item.f17 : close,
    high:   (item.f15 != null && item.f15 > 0) ? item.f15 : close,
    low:    (item.f16 != null && item.f16 > 0) ? item.f16 : close,
    close,
    volume: item.f5 ?? 0,
  };
}

/**
 * 抓取單頁報價
 */
async function fetchPage(
  fs: string,
  page: number,
  pageSize: number,
): Promise<EastMoneyItem[]> {
  const url = 'https://push2.eastmoney.com/api/qt/clist/get?' +
    `pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f6` +
    `&fs=${fs}` +
    '&fields=f2,f5,f12,f14,f15,f16,f17,f18';

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) return [];
  const json = await res.json();
  return json?.data?.diff ?? [];
}

async function fetchMarketQuotes(market: 'cn' | 'us'): Promise<Map<string, EastMoneyQuote>> {
  const map = new Map<string, EastMoneyQuote>();
  // 海外 IP（台灣/Vercel 美國）每頁上限 100 筆
  const pageSize = 100;
  const fs = market === 'cn' ? CN_FS : US_FS;

  // Phase 1: 第一頁取 total 計算所需頁數
  const firstPageItems = await fetchPage(fs, 1, pageSize);
  if (firstPageItems.length === 0) return map;

  for (const item of firstPageItems) {
    const q = parseItem(item, market);
    if (q) map.set(q.code, q);
  }

  // 第一頁不足 pageSize → 全部資料已拿完
  if (firstPageItems.length < pageSize) return map;

  // Phase 2: 並行抓取剩餘頁（10 頁一批避免被限流）
  const BATCH_SIZE = 10;
  const maxTotalPages = market === 'us' ? 100 : 60;

  for (let batchStart = 2; batchStart <= maxTotalPages; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, maxTotalPages);
    const pages = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);

    const results = await Promise.allSettled(
      pages.map(p => fetchPage(fs, p, pageSize))
    );

    let gotEmptyPage = false;
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const items = result.value;
      if (items.length === 0) { gotEmptyPage = true; continue; }

      for (const item of items) {
        const q = parseItem(item, market);
        if (q) map.set(q.code, q);
      }

      if (items.length < pageSize) gotEmptyPage = true;
    }

    if (gotEmptyPage) break;
  }

  return map;
}
