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
export async function getCNChineseName(code: string, suffix?: 'SS' | 'SZ'): Promise<string | null> {
  // 1. 快取（動態 API 取過的最新名字優先）
  // 注意：suffix 不同代表不同 symbol（000001.SS 上證指數 vs 000001.SZ 平安銀行），需分開快取
  const cacheKey = suffix ? `cn:name:${code}.${suffix}` : `cn:name:${code}`;
  const cached = globalCache.get<string>(cacheKey);
  if (cached) return cached;

  // 2. 靜態對照表（CN_STOCKS + 檔案快取，立即返回不打 API）
  // 大多數主板股票都在 CN_NAME_MAP，直接回傳避免 500 支股票 × 5s API timeout
  // 帶 suffix 時跳過靜態表（因 CN_NAME_MAP 不分 SS/SZ，會誤抓股票名給指數）
  if (!suffix && CN_NAME_MAP[code]) {
    globalCache.set(cacheKey, CN_NAME_MAP[code], 24 * 60 * 60 * 1000);
    return CN_NAME_MAP[code];
  }

  // 3. 東方財富 API 動態查詢（僅靜態清單查無時才打 API）
  try {
    // suffix 權威：SS=上海(1.code)、SZ=深圳(0.code)。否則退回首字判斷
    const secid = suffix === 'SS' ? `1.${code}`
      : suffix === 'SZ' ? `0.${code}`
      : code.startsWith('6') ? `1.${code}` : `0.${code}`;
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
    const prefix = suffix === 'SS' ? 'sh' : suffix === 'SZ' ? 'sz' : code.startsWith('6') ? 'sh' : 'sz';
    const url = `https://qt.gtimg.cn/q=${prefix}${code}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buf);
      const match = text.match(/~([^~]+)~/);
      if (match?.[1] && /[一-鿿]/.test(match[1])) {
        const name = match[1];
        // 不帶 suffix 時才寫回 CN_NAME_MAP（避免指數名覆蓋同代碼股票名）
        if (!suffix) {
          CN_NAME_MAP[code] = name;
          persistCNName(code, name);
        }
        globalCache.set(cacheKey, name, 24 * 60 * 60 * 1000);
        return name;
      }
    }
  } catch { /* 騰訊也失敗 */ }

  // 5. 最後 fallback：靜態清單（可能名字過期但總比沒有好；帶 suffix 時跳過避免錯誤）
  return suffix ? null : (CN_NAME_MAP[code] ?? null);
}

const NAMES_CACHE_KEY = 'twse:names:all';
const NAMES_TTL       = 24 * 60 * 60 * 1000; // 24 hours

type NameMap = Record<string, string>; // code → Chinese name

async function buildNameMap(): Promise<NameMap> {
  const map: NameMap = {};

  // 三個來源並行抓取：TWSE上市、TPEx上櫃（可能被Cloudflare擋）、ISIN上櫃備援
  const [listedRes, otcRes, isinOtcRes] = await Promise.allSettled([
    fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
      { signal: AbortSignal.timeout(10000) }),
    fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
      { signal: AbortSignal.timeout(10000) }),
    fetch('https://isin.twse.com.tw/isin/C_public.jsp?strMode=4',
      { signal: AbortSignal.timeout(15000) }),
  ]);

  // 代號 regex：4-5 位數字，允許尾巴帶單一字母（ETF 後綴 A/B/T 等，例如 00981A、00981T）
  const CODE_RE = /^\d{4,5}[A-Z]?$/;

  // 上市股票（TWSE STOCK_DAY_ALL，僅含當日有成交的股票）
  if (listedRes.status === 'fulfilled' && listedRes.value.ok) {
    const data = await listedRes.value.json() as { Code: string; Name: string }[];
    for (const s of data) {
      if (CODE_RE.test(s.Code)) map[s.Code] = s.Name;
    }
  }

  // 上櫃股票：優先用 TPEx JSON，被 Cloudflare 擋時用 ISIN HTML 備援
  if (otcRes.status === 'fulfilled' && otcRes.value.ok) {
    const data = await otcRes.value.json() as { SecuritiesCompanyCode: string; CompanyName: string }[];
    for (const s of data) {
      if (CODE_RE.test(s.SecuritiesCompanyCode)) {
        map[s.SecuritiesCompanyCode] ??= s.CompanyName;
      }
    }
  } else if (isinOtcRes.status === 'fulfilled' && isinOtcRes.value.ok) {
    // ISIN C_public.jsp 回傳 Big5 HTML
    // 用 ISIN 欄位區分股票（TW+10位純數字）與權證（含字母Z）
    const buf  = await isinOtcRes.value.arrayBuffer();
    const text = new TextDecoder('big5').decode(buf);
    for (const [, code, name] of text.matchAll(
      /bgcolor=#FAFAD2>([1-9]\d{3,4})　([^<]+?)<\/td><td bgcolor=#FAFAD2>(TW\d{10})<\/td>/g,
    )) {
      map[code] ??= name.trim();
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
