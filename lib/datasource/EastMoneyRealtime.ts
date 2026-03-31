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
}

// A 股市場代碼
const CN_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
// 美股市場代碼（NASDAQ + NYSE + AMEX）
const US_FS = 'm:105,m:106,m:107';

async function fetchMarketQuotes(market: 'cn' | 'us'): Promise<Map<string, EastMoneyQuote>> {
  const map = new Map<string, EastMoneyQuote>();
  const pageSize = 5000;
  const maxPages = market === 'us' ? 5 : 3; // 美股約 8000+ 檔，需更多頁
  const fs = market === 'cn' ? CN_FS : US_FS;

  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = 'https://push2.eastmoney.com/api/qt/clist/get?' +
        `pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f6` +
        `&fs=${fs}` +
        '&fields=f2,f5,f12,f14,f15,f16,f17';

      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) break;
      const json = await res.json();
      const items: EastMoneyItem[] = json?.data?.diff ?? [];

      if (items.length === 0) break;

      for (const item of items) {
        const code = item.f12;
        if (!code || code === '-') continue;

        const close = item.f2;
        if (!close || close <= 0 || close === '-' as unknown as number) continue;

        if (market === 'cn') {
          // A 股：只保留合法的 A 股代碼前綴，排除 B 股和其他
          if (!/^\d{6}$/.test(code)) continue;
          // 合法 A 股前綴：600/601/603/605(滬主板), 688(科創板),
          //   000/001/002/003(深主板), 300/301(創業板)
          // 排除：200xxx(深B), 900xxx(滬B), 4xxxxx(三板), 8xxxxx(北交所)
          if (!/^(00[0-3]|30[01]|60[0135]|688)\d{3}$/.test(code)) continue;

          map.set(code, {
            code,
            name: (item.f14 && item.f14 !== '-') ? item.f14 : code,
            open:   (item.f17 != null && item.f17 > 0) ? item.f17 : close,
            high:   (item.f15 != null && item.f15 > 0) ? item.f15 : close,
            low:    (item.f16 != null && item.f16 > 0) ? item.f16 : close,
            close,
            volume: (item.f5 ?? 0) * 100, // 手 → 股
          });
        } else {
          // 美股：ticker 為英文字母，東方財富美股成交量單位是股（不是手）
          map.set(code.toUpperCase(), {
            code: code.toUpperCase(),
            name: (item.f14 && item.f14 !== '-') ? item.f14 : code,
            open:   (item.f17 != null && item.f17 > 0) ? item.f17 : close,
            high:   (item.f15 != null && item.f15 > 0) ? item.f15 : close,
            low:    (item.f16 != null && item.f16 > 0) ? item.f16 : close,
            close,
            volume: item.f5 ?? 0, // 美股直接是股
          });
        }
      }

      if (items.length < pageSize) break;
    } catch {
      break;
    }
  }

  return map;
}
