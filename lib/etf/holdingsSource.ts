/**
 * 主動式 ETF 持股資料源（pluggable）
 *
 * 來源優先序：
 *   1. CMoney GetDtnoData API（全持股含張數，免登入，JSON）
 *   2. MoneyDJ Basic0007B（HTML fallback）
 *   3. STUB（demo 用，allowStub=true 時啟用）
 *
 * CMoney API:
 *   https://www.cmoney.tw/MobileService/ashx/GetDtnoData.ashx
 *   DtNo=59449513, ParamStr=AssignID={code};MTPeriod=0;DTMode=0;DTRange=1;DTOrder=1;MajorTable=M722;
 */
import type { ETFHolding, ETFListItem, ETFSnapshot } from './types';

/** 已知的發行商來源 hook */
export type HoldingsFetchResult = { holdings: ETFHolding[]; source: ETFSnapshot['source'] } | null;

/**
 * 主入口：依優先序嘗試各 source。
 * 若所有真實 source 失敗，且 allowStub=true，回 STUB demo 資料。
 */
export async function fetchHoldings(
  etf: ETFListItem,
  date: string,
  options: { allowStub?: boolean } = {},
): Promise<HoldingsFetchResult> {
  // 1) CMoney：完整持股含張數，JSON API
  const cmoney = await fetchFromCMoney(etf.etfCode);
  if (cmoney && cmoney.length > 0) return { holdings: cmoney, source: 'issuer' };

  // 2) MoneyDJ：fallback，HTML server-rendered
  const moneydj = await fetchFromMoneyDJ(etf.etfCode);
  if (moneydj && moneydj.length > 0) return { holdings: moneydj, source: 'issuer' };

  // 3) STUB：產出可信的 demo 資料供開發/驗證
  if (options.allowStub) {
    return { holdings: stubHoldings(etf, date), source: 'stub' };
  }

  return null;
}

// ── CMoney API scraper ───────────────────────────────────────

const CMONEY_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CMONEY_DTNO = '59449513';
/** 接受台股 4-6 位純數字、或美股 1-5 位純大寫字母（CMoney 格式：「TSLA US」→ symbol = "TSLA"） */
const STOCK_CODE_RE = /^(?:\d{4,6}|[A-Z]{1,5})$/;
/** 跳過現金 / 外幣現金 row（symbol 開頭為 "C_" 或為 "CASH"） */
const CASH_ROW_RE = /^(?:C_|CASH$)/i;

interface CMoneyResponse {
  Title: string[];
  Data: string[][];
}

/**
 * 從 CMoney GetDtnoData API 抓取當日完整持股（免登入，JSON）
 * 欄位：[日期, 標的代號, 標的名稱, 權重(%), 持有數, 單位]
 */
async function fetchFromCMoney(etfCode: string): Promise<ETFHolding[] | null> {
  try {
    const paramStr = `AssignID=${etfCode};MTPeriod=0;DTMode=0;DTRange=1;DTOrder=1;MajorTable=M722;`;
    const url = `https://www.cmoney.tw/MobileService/ashx/GetDtnoData.ashx?action=getdtnodata&DtNo=${CMONEY_DTNO}&ParamStr=${encodeURIComponent(paramStr)}&FilterNo=0`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': CMONEY_UA,
        'Referer': `https://www.cmoney.tw/etf/tw/${etfCode}/fundholding`,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const json: CMoneyResponse = await res.json();
    return parseCMoneyHoldings(json.Data ?? []);
  } catch {
    return null;
  }
}

function parseCMoneyHoldings(rows: string[][]): ETFHolding[] {
  const holdings: ETFHolding[] = [];
  for (const r of rows) {
    // r = [date, symbol, name, weight%, shares, unit]
    // CMoney 美股回傳 "TSLA US" / "AMD US" 格式 — 取空白前的代號部分
    const symRaw = r[1] ?? '';
    if (CASH_ROW_RE.test(symRaw)) continue;
    const sym = symRaw.split(/\s+/)[0];
    if (!STOCK_CODE_RE.test(sym)) continue;
    const weightStr = r[3];
    if (!weightStr) continue;
    const weight = parseFloat(weightStr);
    if (isNaN(weight) || weight < 0) continue;
    const sharesRaw = parseInt(r[4] ?? '', 10);
    const shares = isNaN(sharesRaw) || sharesRaw <= 0 ? undefined : sharesRaw;
    // Skip rows that are both 0% and have no shares (truly empty)
    if (weight === 0 && !shares) continue;
    holdings.push({ symbol: sym, name: r[2], weight, ...(shares !== undefined ? { shares } : {}) });
  }
  return holdings;
}

// ── MoneyDJ scraper (fallback) ───────────────────────────────

const MONEYDJ_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * 從 MoneyDJ Basic0007B 抓取全部持股（server-rendered HTML，免登入）
 * URL: https://www.moneydj.com/ETF/X/Basic/Basic0007B.xdjhtm?etfid=00981A.TW
 */
async function fetchFromMoneyDJ(etfCode: string): Promise<ETFHolding[] | null> {
  try {
    const url = `https://www.moneydj.com/ETF/X/Basic/Basic0007B.xdjhtm?etfid=${etfCode}.TW`;
    const res = await fetch(url, {
      headers: { 'User-Agent': MONEYDJ_UA, 'Accept-Language': 'zh-TW,zh;q=0.9' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseMoneyDJHoldings(html);
  } catch {
    return null;
  }
}

function parseMoneyDJHoldings(html: string): ETFHolding[] {
  const holdings: ETFHolding[] = [];
  const rowRe = /col05">(.*?)<\/td>.*?col06">([\d.]+).*?col07">([\d,]*)/gs;
  const linkRe = /etfid=([\dA-Z]+)\.TW[^>]*>(.*?)\(/;

  for (const rowMatch of html.matchAll(rowRe)) {
    const [, cell05, weightStr, sharesStr] = rowMatch;
    const linkMatch = cell05.match(linkRe);
    if (!linkMatch) continue;
    const symbol = linkMatch[1];
    const name = linkMatch[2].trim().replace(/\*$/, '').trim();
    const weight = parseFloat(weightStr);
    const sharesRaw = sharesStr ? parseInt(sharesStr.replace(/,/g, ''), 10) : NaN;
    const shares = isNaN(sharesRaw) || sharesRaw === 0 ? undefined : sharesRaw;
    if (symbol && name && !isNaN(weight)) {
      holdings.push({ symbol, name, weight, ...(shares !== undefined ? { shares } : {}) });
    }
  }
  return holdings;
}

// ── STUB（demo）─────────────────────────────────────────────

const TW_BLUE_CHIPS: ReadonlyArray<{ symbol: string; name: string }> = [
  { symbol: '2330', name: '台積電' },
  { symbol: '2317', name: '鴻海' },
  { symbol: '2454', name: '聯發科' },
  { symbol: '2308', name: '台達電' },
  { symbol: '2382', name: '廣達' },
  { symbol: '2412', name: '中華電' },
  { symbol: '2891', name: '中信金' },
  { symbol: '3711', name: '日月光投控' },
  { symbol: '2881', name: '富邦金' },
  { symbol: '1303', name: '南亞' },
  { symbol: '2002', name: '中鋼' },
  { symbol: '2303', name: '聯電' },
  { symbol: '2603', name: '長榮' },
  { symbol: '3008', name: '大立光' },
  { symbol: '2885', name: '元大金' },
];

/**
 * 確定性偽隨機（依 etfCode + date）：每次同樣輸入產生相同輸出。
 * 用於 demo / 開發。
 */
function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 13), 1597463007);
    const j = Math.abs(h) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function stubHoldings(etf: ETFListItem, date: string): ETFHolding[] {
  const shuffled = seededShuffle(TW_BLUE_CHIPS, `${etf.etfCode}-${date}`);
  const count = 8 + (Math.abs(hashStr(etf.etfCode + date)) % 4); // 8–11 檔
  const picks = shuffled.slice(0, count);
  // 每檔權重：先給隨機正數，再 normalize 到總和≈95%（5% 為現金）
  const rawWeights = picks.map((_, i) => 5 + ((Math.abs(hashStr(date + i)) % 1000) / 100));
  const total = rawWeights.reduce((s, w) => s + w, 0);
  return picks.map((p, i) => ({
    symbol: p.symbol,
    name: p.name,
    weight: Number(((rawWeights[i] / total) * 95).toFixed(2)),
  }));
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i);
  return h;
}
