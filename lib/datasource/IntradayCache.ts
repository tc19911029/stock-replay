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
    // CN: 東方財富 → 騰訊 fallback
    const { getEastMoneyRealtime } = await import('./EastMoneyRealtime');
    let cnMap = await getEastMoneyRealtime();
    let cnSource = 'EastMoney';

    // 東方財富返回 0 筆 → fallback 騰訊
    if (cnMap.size === 0) {
      console.warn(`[IntradayCache] CN EastMoney 返回 0 筆，嘗試騰訊 fallback...`);
      try {
        const { getTencentRealtime } = await import('./TencentRealtime');
        const { CN_STOCKS } = await import('@/lib/scanner/cnStocks');
        const symbols = CN_STOCKS.map(s => s.symbol);
        cnMap = await getTencentRealtime(symbols);
        cnSource = 'Tencent';
        if (cnMap.size > 0) {
          console.info(`[IntradayCache] CN 騰訊 fallback 成功: ${cnMap.size} 筆`);
        } else {
          console.warn(`[IntradayCache] CN 騰訊 fallback 也返回 0 筆`);
        }
      } catch (err) {
        console.warn(`[IntradayCache] CN 騰訊 fallback 失敗:`, err);
      }
    }

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
    for (const [, q] of cnMap) {
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

    if (quotes.length > 0) {
      console.info(`[IntradayCache] CN L2 來源: ${cnSource}, ${quotes.length} 筆`);
    }
  }

  // ── 空快照保護：API 失敗時不覆蓋既有有效數據，且不寫入空檔案 ──
  if (quotes.length === 0) {
    console.warn(`[IntradayCache] ${market} API 返回 0 筆報價，檢查現有快照...`);
    const existing = await readIntradaySnapshot(market, today);
    if (existing && existing.quotes.length > 0) {
      console.warn(`[IntradayCache] 保留現有快照 (${existing.quotes.length} 筆)，不覆蓋空數據`);
      return existing;
    }
    // API 返回 0 + 無既有快照 → 不寫入磁碟（可能是盤後啟動、市場休市、或 API 暫時故障）
    // 避免在本地 dev 盤後啟動時把空檔覆蓋掉之後有效的快照
    console.warn(`[IntradayCache] ${market} 無現有快照且 API 返回 0，跳過寫入磁碟`);
    return { market, date: today, updatedAt: new Date().toISOString(), count: 0, quotes: [] };
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
