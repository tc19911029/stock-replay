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
  volume: number;     // 股數
}

const REALTIME_CACHE_KEY = 'twse:realtime:all';
const REALTIME_TTL = 30 * 1000; // 30 秒

/** 正在進行中的 fetch promise（避免同時多次請求） */
let inflightPromise: Promise<Map<string, TWSEQuote>> | null = null;

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
  Code: string;
  Name: string;
  OpeningPrice: string;
  HighestPrice: string;
  LowestPrice: string;
  ClosingPrice: string;
  TradeVolume: string;
}

interface TPExRawRow {
  SecuritiesCompanyCode: string;
  CompanyName: string;
  Open: string;
  High: string;
  Low: string;
  Close: string;
  TradingShares: string;
}

function parseNum(s: string | undefined): number {
  if (!s) return 0;
  const n = parseFloat(s.replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
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
        map.set(row.Code, {
          code: row.Code,
          name: row.Name?.trim() ?? row.Code,
          open: parseNum(row.OpeningPrice),
          high: parseNum(row.HighestPrice),
          low: parseNum(row.LowestPrice),
          close,
          volume: parseNum(row.TradeVolume),
        });
      }
    } catch (e) {
      console.warn('[TWSERealtime] TWSE parse error:', e);
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
        map.set(code, {
          code,
          name: row.CompanyName?.trim() ?? code,
          open: parseNum(row.Open),
          high: parseNum(row.High),
          low: parseNum(row.Low),
          close,
          volume: parseNum(row.TradingShares),
        });
      }
    } catch (e) {
      console.warn('[TWSERealtime] TPEx parse error:', e);
    }
  }

  if (map.size > 0) {
    console.log(`[TWSERealtime] 取得 ${map.size} 檔即時報價`);
  }

  return map;
}
