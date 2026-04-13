/**
 * IntradayCache — Layer 2 盤中即時快取層
 *
 * 將全市場即時報價存為單一 JSON 檔案（非逐檔），
 * 確保粗掃時只需 1 次 Blob read（< 100ms），
 * 解決 Vercel 手機掃描超時（原本 3800 次 Blob read → 570s）。
 *
 * 資料來源:
 *   TW: TWSE mis API + TPEx → getTWSERealtimeIntraday()
 *   CN: EastMoney push2 → getEastMoneyRealtime()
 *
 * 儲存格式:
 *   Blob: intraday/{market}/{date}.json
 *   Local: data/intraday-{market}-{date}.json
 *
 * 此層獨立於 Layer 1（歷史日K），不可互相覆蓋。
 */

import { globalCache } from './MemoryCache';

// ── Types ───────────────────────────────────────────────────────────────────

export interface IntradayQuote {
  /** 純代碼 e.g. "2330", "600519" */
  symbol: string;
  name: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 昨收（可用於算漲跌幅） */
  prevClose: number;
  /** 漲跌幅 % */
  changePercent: number;
}

export interface IntradaySnapshot {
  market: 'TW' | 'CN';
  date: string;            // YYYY-MM-DD
  updatedAt: string;       // ISO timestamp
  count: number;
  quotes: IntradayQuote[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const MEMORY_TTL = 60 * 1000; // memory cache 60 秒
const IS_VERCEL = !!process.env.VERCEL;

// ── Blob / FS helpers ───────────────────────────────────────────────────────

function blobKey(market: 'TW' | 'CN', date: string): string {
  return `intraday/${market}/${date}.json`;
}

function localFilename(market: 'TW' | 'CN', date: string): string {
  return `intraday-${market}-${date}.json`;
}

async function blobPut(pathname: string, data: string): Promise<void> {
  const { put } = await import('@vercel/blob');
  await put(pathname, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
}

async function blobGet(pathname: string): Promise<string | null> {
  const { get } = await import('@vercel/blob');
  const result = await get(pathname, { access: 'private' });
  if (!result || !result.stream) return null;
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fsPut(filename: string, data: string): Promise<void> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const dir = path.join(process.cwd(), 'data');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), data, 'utf-8');
}

async function fsGet(filename: string): Promise<string | null> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  try {
    return await fs.readFile(path.join(process.cwd(), 'data', filename), 'utf-8');
  } catch {
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * 寫入全市場盤中快照（單一檔案）
 * 由 cron 或掃描前自動觸發
 */
export async function writeIntradaySnapshot(snapshot: IntradaySnapshot): Promise<void> {
  const json = JSON.stringify(snapshot);
  const key = blobKey(snapshot.market, snapshot.date);
  const filename = localFilename(snapshot.market, snapshot.date);

  if (IS_VERCEL) {
    await blobPut(key, json);
  }

  // 也寫本地（開發用 + Vercel warm instance）
  try {
    await fsPut(filename, json);
  } catch {
    // Vercel 只讀目錄，忽略
  }

  // 更新 memory cache
  const cacheKey = `intraday:${snapshot.market}:${snapshot.date}`;
  globalCache.set(cacheKey, snapshot, MEMORY_TTL);
}

/**
 * 讀取全市場盤中快照
 * 優先 memory cache → Blob → 本地檔案
 */
export async function readIntradaySnapshot(
  market: 'TW' | 'CN',
  date: string,
): Promise<IntradaySnapshot | null> {
  // Memory cache
  const cacheKey = `intraday:${market}:${date}`;
  const cached = globalCache.get<IntradaySnapshot>(cacheKey);
  if (cached) return cached;

  let raw: string | null = null;

  if (IS_VERCEL) {
    raw = await blobGet(blobKey(market, date));
  }

  if (!raw) {
    raw = await fsGet(localFilename(market, date));
  }

  if (!raw) return null;

  try {
    const snapshot: IntradaySnapshot = JSON.parse(raw);
    globalCache.set(cacheKey, snapshot, MEMORY_TTL);
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * 判斷快照是否足夠新鮮（用於決定是否需要重新抓取）
 * @param maxAgeMs 最大允許年齡（毫秒），預設 120000 (2 分鐘)
 */
export function isSnapshotFresh(snapshot: IntradaySnapshot | null, maxAgeMs = 120_000): boolean {
  if (!snapshot) return false;
  const age = Date.now() - new Date(snapshot.updatedAt).getTime();
  return age < maxAgeMs;
}

// ── Fetch & Build ───────────────────────────────────────────────────────────

/**
 * 從即時 API 抓取並寫入全市場快照
 * TW: TWSE mis + TPEx
 * CN: EastMoney push2
 */
export async function refreshIntradaySnapshot(market: 'TW' | 'CN'): Promise<IntradaySnapshot> {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
  }).format(new Date());

  let quotes: IntradayQuote[];

  if (market === 'TW') {
    const { getTWSERealtimeIntraday } = await import('./TWSERealtime');
    const twseMap = await getTWSERealtimeIntraday();
    quotes = [];
    for (const [, q] of twseMap) {
      const prevClose = q.previousClose ?? q.close;
      const changePercent = prevClose > 0 ? ((q.close - prevClose) / prevClose) * 100 : 0;
      quotes.push({
        symbol: q.code,
        name: q.name,
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume,
        prevClose,
        changePercent: Math.round(changePercent * 100) / 100,
      });
    }
  } else {
    const { getEastMoneyRealtime } = await import('./EastMoneyRealtime');
    const emMap = await getEastMoneyRealtime();

    // 嘗試讀取 MA Base 以補足 prevClose / changePercent
    let maBaseMap: Record<string, { closes: number[] }> = {};
    try {
      const maBase = await readMABase(market, today);
      if (maBase) {
        for (const [sym, entry] of Object.entries(maBase.data)) {
          if (entry.closes.length > 0) {
            maBaseMap[sym] = { closes: entry.closes };
          }
        }
      }
    } catch { /* ignore - MA base 尚不存在 */ }

    quotes = [];
    for (const [, q] of emMap) {
      // 優先使用 API 的 f18 昨收 → 其次 MA Base 最後一根收盤 → 最後降級為 close（漲跌=0%）
      const ma = maBaseMap[q.code];
      const prevClose = q.prevClose ?? ma?.closes[ma.closes.length - 1] ?? q.close;
      const changePercent = prevClose > 0
        ? Math.round(((q.close - prevClose) / prevClose) * 10000) / 100
        : 0;
      quotes.push({
        symbol: q.code,
        name: q.name,
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume,
        prevClose,
        changePercent,
      });
    }
  }

  const snapshot: IntradaySnapshot = {
    market,
    date: today,
    updatedAt: new Date().toISOString(),
    count: quotes.length,
    quotes,
  };

  await writeIntradaySnapshot(snapshot);

  console.info(`[IntradayCache] ${market} 快照已更新: ${quotes.length} 檔 @ ${today}`);
  return snapshot;
}

// ── MA Base (歷史尾端快取) ──────────────────────────────────────────────────

export interface MABaseEntry {
  /** 最近 N 根收盤價（由舊到新） */
  closes: number[];
  /** 最近 N 根成交量（由舊到新） */
  volumes: number[];
}

export interface MABaseSnapshot {
  market: 'TW' | 'CN';
  date: string;           // 最後封存日期
  updatedAt: string;
  /** symbol → MABaseEntry */
  data: Record<string, MABaseEntry>;
}

function maBaseBlobKey(market: 'TW' | 'CN', date: string): string {
  return `intraday/${market}/${date}-ma-base.json`;
}

function maBaseLocalFilename(market: 'TW' | 'CN', date: string): string {
  return `intraday-${market}-${date}-ma-base.json`;
}

/**
 * 寫入 MA Base（收盤 cron 時呼叫）
 */
export async function writeMABase(base: MABaseSnapshot): Promise<void> {
  const json = JSON.stringify(base);
  if (IS_VERCEL) {
    await blobPut(maBaseBlobKey(base.market, base.date), json);
  }
  try {
    await fsPut(maBaseLocalFilename(base.market, base.date), json);
  } catch { /* ignore */ }

  const cacheKey = `mabase:${base.market}:${base.date}`;
  globalCache.set(cacheKey, base, 24 * 60 * 60 * 1000); // 24 小時
}

/**
 * 讀取 MA Base
 */
export async function readMABase(
  market: 'TW' | 'CN',
  date: string,
): Promise<MABaseSnapshot | null> {
  const cacheKey = `mabase:${market}:${date}`;
  const cached = globalCache.get<MABaseSnapshot>(cacheKey);
  if (cached) return cached;

  let raw: string | null = null;
  if (IS_VERCEL) {
    raw = await blobGet(maBaseBlobKey(market, date));
  }
  if (!raw) {
    raw = await fsGet(maBaseLocalFilename(market, date));
  }
  if (!raw) return null;

  try {
    const base: MABaseSnapshot = JSON.parse(raw);
    globalCache.set(cacheKey, base, 24 * 60 * 60 * 1000);
    return base;
  } catch {
    return null;
  }
}
