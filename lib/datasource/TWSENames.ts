/**
 * TWSENames.ts — 台灣上市/上櫃股票中文名稱快取查詢
 *
 * 從 TWSE / TPEx OpenAPI 取得全市場股票代號 → 中文名稱對照表，
 * 快取 24 小時，讓個股資料 API 可以補上中文公司名。
 */

import fs from 'fs';
import path from 'path';
import { globalCache } from './MemoryCache';
import { CN_STOCKS } from '@/lib/scanner/cnStocks';

/** A 股代號 → 中文名靜態對照表（從 ChinaScanner 清單建立） */
const CN_NAME_MAP: Record<string, string> = Object.fromEntries(
  CN_STOCKS.map(s => [s.symbol.replace(/\.(SS|SZ)$/i, ''), s.name]),
);

/** 檔案快取路徑（持久化動態查詢到的名稱，避免重啟後重查） */
const CN_FILE_CACHE = path.join(process.cwd(), '.cache', 'cn-names.json');

// 啟動時載入檔案快取，補充靜態清單沒有的名稱
try {
  const saved = JSON.parse(fs.readFileSync(CN_FILE_CACHE, 'utf-8')) as Record<string, string>;
  for (const [code, name] of Object.entries(saved)) {
    CN_NAME_MAP[code] ??= name;
  }
} catch { /* 檔案不存在或讀取失敗，忽略 */ }

/** 將動態查詢到的名稱寫回檔案快取 */
function persistCNName(code: string, name: string): void {
  try {
    let saved: Record<string, string> = {};
    try { saved = JSON.parse(fs.readFileSync(CN_FILE_CACHE, 'utf-8')); } catch { /* 新檔 */ }
    if (saved[code] === name) return; // 已存在，不重寫
    saved[code] = name;
    fs.mkdirSync(path.dirname(CN_FILE_CACHE), { recursive: true });
    fs.writeFileSync(CN_FILE_CACHE, JSON.stringify(saved, null, 2), 'utf-8');
  } catch { /* 寫入失敗，不影響主流程 */ }
}

/**
 * 查詢 A 股中文名稱（滬市/深市 6 位代號）。
 * 優先查靜態對照表，查無則從東方財富 API 動態取得並快取。
 * @param code  純數字代號，例如 "603986"
 * @returns     中文公司名，若查無則回傳 null
 */
export async function getCNChineseName(code: string): Promise<string | null> {
  // 1. 快取（動態 API 取過的最新名字優先）
  const cacheKey = `cn:name:${code}`;
  const cached = globalCache.get<string>(cacheKey);
  if (cached) return cached;

  // 3. 東方財富 API 動態查詢
  try {
    const secid = code.startsWith('6') ? `1.${code}` : `0.${code}`;
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f58&_=${Date.now()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const json = await res.json();
      const name = json?.data?.f58;
      if (name && typeof name === 'string') {
        CN_NAME_MAP[code] = name;
        globalCache.set(cacheKey, name, 24 * 60 * 60 * 1000);
        persistCNName(code, name);
        return name;
      }
    }
  } catch { /* 東方財富失敗，嘗試騰訊 */ }

  // 4. 騰訊財經 API（備援，GBK 編碼）
  try {
    const prefix = code.startsWith('6') ? 'sh' : 'sz';
    const url = `https://qt.gtimg.cn/q=${prefix}${code}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buf);
      const match = text.match(/~([^~]+)~/);
      if (match?.[1] && /[\u4e00-\u9fff]/.test(match[1])) {
        const name = match[1];
        CN_NAME_MAP[code] = name;
        globalCache.set(cacheKey, name, 24 * 60 * 60 * 1000);
        persistCNName(code, name);
        return name;
      }
    }
  } catch { /* 騰訊也失敗 */ }

  // 5. 最後 fallback：靜態清單（可能名字過期但總比沒有好）
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
