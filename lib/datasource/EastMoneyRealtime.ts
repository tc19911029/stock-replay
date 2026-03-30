/**
 * EastMoneyRealtime.ts — 東方財富 A 股即時報價
 *
 * 從東方財富 push2 API 取得全市場 A 股即時 OHLCV，快取 30 秒。
 * 用途：覆蓋 Yahoo Finance 延遲 15-20 分鐘的最後一根日 K。
 *
 * 東方財富欄位對照：
 *   f12=代碼, f14=名稱, f17=開盤, f15=最高, f16=最低, f2=最新價,
 *   f5=成交量(手), f6=成交額
 */

import { globalCache } from './MemoryCache';

export interface EastMoneyQuote {
  code: string;       // 6 位代碼，如 "600519"
  name: string;
  open: number;
  high: number;
  low: number;
  close: number;      // 最新價
  volume: number;     // 成交量（股）
}

const REALTIME_CACHE_KEY = 'eastmoney:realtime:all';
const REALTIME_TTL = 30 * 1000; // 30 秒

let inflightPromise: Promise<Map<string, EastMoneyQuote>> | null = null;

/**
 * 取得全市場 A 股即時報價 Map（code → EastMoneyQuote）
 */
export async function getEastMoneyRealtime(): Promise<Map<string, EastMoneyQuote>> {
  const cached = globalCache.get<Map<string, EastMoneyQuote>>(REALTIME_CACHE_KEY);
  if (cached) return cached;

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
 * 取得單一 A 股的即時報價
 * @param code 6 位純數字代碼（不含 .SS/.SZ）
 */
export async function getEastMoneyQuote(code: string): Promise<EastMoneyQuote | null> {
  const map = await getEastMoneyRealtime();
  return map.get(code) ?? null;
}

// ── 內部實作 ──────────────────────────────────────────────────────────────────

interface EastMoneyItem {
  f2: number;   // 最新價
  f5: number;   // 成交量（手，1手=100股）
  f12: string;  // 代碼
  f14: string;  // 名稱
  f15: number;  // 最高
  f16: number;  // 最低
  f17: number;  // 開盤
}

async function fetchAllQuotes(): Promise<Map<string, EastMoneyQuote>> {
  const map = new Map<string, EastMoneyQuote>();
  const pageSize = 5000;
  const maxPages = 3;

  for (let page = 1; page <= maxPages; page++) {
    try {
      // f2=最新價, f5=成交量(手), f12=代碼, f14=名稱, f15=最高, f16=最低, f17=開盤
      const url = 'https://push2.eastmoney.com/api/qt/clist/get?' +
        `pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f6` +
        '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23' +
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
        if (!/^\d{6}$/.test(code)) continue;
        if (code.startsWith('900') || code.startsWith('200')) continue; // 排除 B 股

        const close = item.f2;
        if (!close || close <= 0 || close === '-' as unknown as number) continue;

        map.set(code, {
          code,
          name: (item.f14 && item.f14 !== '-') ? item.f14 : code,
          open:   item.f17 > 0 ? item.f17 : close,
          high:   item.f15 > 0 ? item.f15 : close,
          low:    item.f16 > 0 ? item.f16 : close,
          close,
          volume: (item.f5 ?? 0) * 100, // 手 → 股
        });
      }

      if (items.length < pageSize) break;
    } catch (e) {
      console.warn(`[EastMoneyRealtime] page ${page} error:`, e);
      break;
    }
  }

  if (map.size > 0) {
    console.log(`[EastMoneyRealtime] 取得 ${map.size} 檔 A 股即時報價`);
  }

  return map;
}
