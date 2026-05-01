/**
 * 主動式 ETF 持股資料源（pluggable）
 *
 * 來源優先序：
 *   1. MoneyDJ Basic0007B（全部持股，HTML server-rendered，免登入）
 *   2. STUB（demo 用，allowStub=true 時啟用）
 *
 * 加入新 source 步驟：
 *   1. 新增 fetchFromXxx(etfCode, date) → ETFHolding[] | null
 *   2. 在 fetchHoldings() 內依序 try
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
  // 1) MoneyDJ：全部持股，免登入，server-rendered HTML
  const moneydj = await fetchFromMoneyDJ(etf.etfCode);
  if (moneydj && moneydj.length > 0) return { holdings: moneydj, source: 'issuer' };

  // 2) STUB：產出可信的 demo 資料供開發/驗證
  if (options.allowStub) {
    return { holdings: stubHoldings(etf, date), source: 'stub' };
  }

  return null;
}

// ── MoneyDJ scraper ──────────────────────────────────────────

const MONEYDJ_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * 從 MoneyDJ Basic0007B 抓取全部持股（server-rendered HTML，免登入）
 * URL: https://www.moneydj.com/ETF/X/Basic/Basic0007B.xdjhtm?etfid=00981A.TW
 *
 * 每筆 row 結構：
 *   col05: <a href='...etfid=2330.TW...'>台積電(2330.TW)</a>
 *   col06: 8.97
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

  // Extract all col05 (name+code) and col06 (weight) cells
  const rowRe = /col05">(.*?)<\/td>.*?col06">([\d.]+)/gs;
  const linkRe = /etfid=([\dA-Z]+)\.TW[^>]*>(.*?)\(/;

  for (const rowMatch of html.matchAll(rowRe)) {
    const [, cell05, weightStr] = rowMatch;
    const linkMatch = cell05.match(linkRe);
    if (!linkMatch) continue;

    const symbol = linkMatch[1];
    // Extract name: everything before the last '('
    const nameRaw = linkMatch[2].trim();
    // Clean asterisk used by MoneyDJ for notes (e.g. "國巨*(2327.TW)")
    const name = nameRaw.replace(/\*$/, '').trim();
    const weight = parseFloat(weightStr);

    if (symbol && name && !isNaN(weight)) {
      holdings.push({ symbol, name, weight });
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
