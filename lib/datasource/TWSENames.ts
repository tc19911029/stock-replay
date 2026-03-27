/**
 * TWSENames.ts — 台灣上市/上櫃股票中文名稱快取查詢
 *
 * 從 TWSE / TPEx OpenAPI 取得全市場股票代號 → 中文名稱對照表，
 * 快取 24 小時，讓個股資料 API 可以補上中文公司名。
 */

import { globalCache } from './MemoryCache';
import { CN_STOCKS } from '@/lib/scanner/ChinaScanner';

/** A 股代號 → 中文名靜態對照表（從 ChinaScanner 清單建立） */
const CN_NAME_MAP: Record<string, string> = Object.fromEntries(
  CN_STOCKS.map(s => [s.symbol.replace(/\.(SS|SZ)$/i, ''), s.name]),
);

/**
 * 查詢 A 股中文名稱（滬市/深市 6 位代號）。
 * @param code  純數字代號，例如 "603986"
 * @returns     中文公司名，若查無則回傳 null
 */
export function getCNChineseName(code: string): string | null {
  return CN_NAME_MAP[code] ?? null;
}

const NAMES_CACHE_KEY = 'twse:names:all';
const NAMES_TTL       = 24 * 60 * 60 * 1000; // 24 hours

type NameMap = Record<string, string>; // code (4 digits) → Chinese name

async function buildNameMap(): Promise<NameMap> {
  const map: NameMap = {};

  const [listedRes, otcRes] = await Promise.allSettled([
    fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
      { signal: AbortSignal.timeout(10000) }),
    fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
      { signal: AbortSignal.timeout(10000) }),
  ]);

  if (listedRes.status === 'fulfilled' && listedRes.value.ok) {
    const data = await listedRes.value.json() as { Code: string; Name: string }[];
    for (const s of data) {
      if (/^\d{4}$/.test(s.Code)) map[s.Code] = s.Name;
    }
  }

  if (otcRes.status === 'fulfilled' && otcRes.value.ok) {
    const data = await otcRes.value.json() as { SecuritiesCompanyCode: string; CompanyName: string }[];
    for (const s of data) {
      if (/^\d{4}$/.test(s.SecuritiesCompanyCode)) {
        map[s.SecuritiesCompanyCode] ??= s.CompanyName;
      }
    }
  }

  return map;
}

/**
 * 查詢台灣股票中文名稱。
 * @param code  純數字代號（不帶 .TW/.TWO），例如 "2330"
 * @returns     中文公司名，若查無則回傳 null
 */
export async function getTWChineseName(code: string): Promise<string | null> {
  let map = globalCache.get<NameMap>(NAMES_CACHE_KEY);

  if (!map) {
    try {
      map = await buildNameMap();
      if (Object.keys(map).length > 0) {
        globalCache.set(NAMES_CACHE_KEY, map, NAMES_TTL);
      }
    } catch {
      return null;
    }
  }

  return map[code] ?? null;
}
