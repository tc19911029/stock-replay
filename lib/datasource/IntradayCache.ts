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
import { isTradingDay } from '@/lib/utils/tradingDay';

// ── Types ───────────────────────────────────────────────────────────────────

/** 每個數據源的調用結果，供 Health API 使用 */
export interface DataSourceStatus {
  source: string;           // 'EastMoney' | 'Tencent' | 'TWSE' | 'TPEx'
  success: boolean;
  quoteCount: number;
  errorMessage?: string;
  responseTimeMs: number;
  timestamp: string;        // ISO
}

/** L2 刷新結果摘要（附加到 snapshot 響應） */
export interface L2RefreshSummary {
  sources: DataSourceStatus[];
  consecutiveEmptyCount: number;
  isTradingDayFlag: boolean;
  alertLevel: 'none' | 'warning' | 'critical';
}

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

// ── 數據源狀態追蹤（模組級） ──────────────────────────────────────────────

/** 每個市場最近一次刷新的各數據源狀態 */
const _lastSourceStatus: Record<string, DataSourceStatus[]> = {};

/** 每個市場連續空快照計數（API 都返回 0） */
const _consecutiveEmptyCount: Record<string, number> = { TW: 0, CN: 0 };

/** 每個市場最近一次嘗試刷新的時間（不論成功或失敗） */
const _lastRefreshAttempt: Record<string, string> = {};

/** 取得指定市場最近一次刷新的數據源狀態 */
export function getDataSourceStatus(market: 'TW' | 'CN'): DataSourceStatus[] {
  return _lastSourceStatus[market] ?? [];
}

/** 取得指定市場連續空快照次數 */
export function getConsecutiveEmptyCount(market: 'TW' | 'CN'): number {
  return _consecutiveEmptyCount[market] ?? 0;
}

/** 取得指定市場最近一次嘗試刷新的時間（區分「cron 沒跑」vs「API 掛了用快取」） */
export function getLastRefreshAttempt(market: 'TW' | 'CN'): string | null {
  return _lastRefreshAttempt[market] ?? null;
}

/** 計時工具 */
function timedFetch<T>(fn: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const start = Date.now();
  return fn().then(result => ({ result, elapsedMs: Date.now() - start }));
}

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
  // 記錄嘗試時間（不論成功或失敗），讓 health API 區分 cron 沒跑 vs API 掛了
  _lastRefreshAttempt[market] = new Date().toISOString();

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
  }).format(new Date());

  const sources: DataSourceStatus[] = [];
  let quotes: IntradayQuote[];

  if (market === 'TW') {
    quotes = await _fetchTWQuotes(sources);
  } else {
    quotes = await _fetchCNQuotes(sources, today);
  }

  // 記錄本次數據源狀態
  _lastSourceStatus[market] = sources;

  // ── 空快照保護 + API 失敗 ≠ 休市 判斷 ──
  if (quotes.length === 0) {
    const tradingDay = isTradingDay(today, market);

    if (tradingDay) {
      // ★ 核心修復：交易日但 API 全部返回 0 → 延遲 10 秒重試一次
      console.error(
        `[IntradayCache] ★ ${market} 交易日 ${today} 所有數據源返回 0 筆！` +
        `連續第 ${_consecutiveEmptyCount[market] + 1} 次。` +
        `數據源狀態: ${JSON.stringify(sources.map(s => `${s.source}:${s.success}/${s.quoteCount}`))}`
      );

      // 延遲 10 秒後重試（可能是 API 暫時性故障）
      await new Promise(resolve => setTimeout(resolve, 10_000));

      const retrySources: DataSourceStatus[] = [];
      const retryQuotes = market === 'TW'
        ? await _fetchTWQuotes(retrySources)
        : await _fetchCNQuotes(retrySources, today);

      // 更新數據源狀態（追加重試結果）
      for (const s of retrySources) {
        sources.push({ ...s, source: `${s.source}(retry)` });
      }
      _lastSourceStatus[market] = sources;

      if (retryQuotes.length > 0) {
        console.info(`[IntradayCache] ${market} 重試成功: ${retryQuotes.length} 筆`);
        quotes = retryQuotes;
        _consecutiveEmptyCount[market] = 0;
      } else {
        _consecutiveEmptyCount[market]++;
        console.error(
          `[IntradayCache] ★★ ${market} 重試仍然 0 筆！` +
          `連續空快照 ${_consecutiveEmptyCount[market]} 次。` +
          `這是 API 故障，不是休市！`
        );
      }
    } else {
      // 非交易日 → 正常行為，不算 API 故障
      console.info(`[IntradayCache] ${market} ${today} 非交易日，API 返回 0 筆為預期行為`);
      _consecutiveEmptyCount[market] = 0;
    }
  } else {
    // 有數據 → 重置連續空計數
    _consecutiveEmptyCount[market] = 0;
  }

  // ── 最終空快照保護（不管原因） ──
  if (quotes.length === 0) {
    const existing = await readIntradaySnapshot(market, today);
    if (existing && existing.quotes.length > 0) {
      console.warn(`[IntradayCache] 保留現有快照 (${existing.quotes.length} 筆)，不覆蓋空數據`);
      return existing;
    }
    console.warn(`[IntradayCache] ${market} 無現有快照且無數據，跳過寫入磁碟`);
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

/**
 * 取得本次刷新的摘要（供 cron 端點回傳）
 */
export function getLastRefreshSummary(market: 'TW' | 'CN'): L2RefreshSummary {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
  }).format(new Date());
  const trading = isTradingDay(today, market);
  const empty = _consecutiveEmptyCount[market] ?? 0;

  let alertLevel: L2RefreshSummary['alertLevel'] = 'none';
  if (trading && empty >= 3) alertLevel = 'critical';
  else if (trading && empty >= 1) alertLevel = 'warning';

  return {
    sources: _lastSourceStatus[market] ?? [],
    consecutiveEmptyCount: empty,
    isTradingDayFlag: trading,
    alertLevel,
  };
}

// ── 內部：TW 報價抓取 ─────────────────────────────────────────────────────

/** mis.twse 盤中即時回傳的最低預期數量，低於此值視為失敗，降級到 OpenAPI */
const TW_MIN_EXPECTED = 500;

async function _fetchTWQuotes(sources: DataSourceStatus[]): Promise<IntradayQuote[]> {
  const { getTWSERealtimeIntraday, getTWSEDailyAll } = await import('./TWSERealtime');

  // 1. 先試 mis.twse 盤中即時報價（真正即時，但間歇性不穩定）
  const { result: twseMap, elapsedMs } = await timedFetch(() => getTWSERealtimeIntraday());

  sources.push({
    source: 'TWSE+TPEx(mis)',
    success: twseMap.size >= TW_MIN_EXPECTED,
    quoteCount: twseMap.size,
    responseTimeMs: elapsedMs,
    timestamp: new Date().toISOString(),
  });

  // 2. mis.twse 回傳不足 → 降級到 OpenAPI（STOCK_DAY_ALL，更穩定但稍慢）
  let finalMap = twseMap;
  if (twseMap.size < TW_MIN_EXPECTED) {
    const reason = twseMap.size === 0 ? '返回 0 筆' : `僅 ${twseMap.size} 筆`;
    console.warn(`[IntradayCache] TW mis.twse ${reason}，降級到 OpenAPI STOCK_DAY_ALL...`);
    try {
      const { result: dailyMap, elapsedMs: dailyMs } = await timedFetch(() => getTWSEDailyAll());
      sources.push({
        source: 'TWSE+TPEx(OpenAPI)',
        success: dailyMap.size > 0,
        quoteCount: dailyMap.size,
        responseTimeMs: dailyMs,
        timestamp: new Date().toISOString(),
      });
      if (dailyMap.size > 0) {
        finalMap = dailyMap;
        console.info(`[IntradayCache] TW OpenAPI fallback 成功: ${dailyMap.size} 筆`);
      } else {
        console.warn('[IntradayCache] TW OpenAPI fallback 也返回 0 筆');
      }
    } catch (err) {
      sources.push({
        source: 'TWSE+TPEx(OpenAPI)',
        success: false,
        quoteCount: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
        responseTimeMs: 0,
        timestamp: new Date().toISOString(),
      });
      console.warn('[IntradayCache] TW OpenAPI fallback 失敗:', err);
    }
  }

  const quotes: IntradayQuote[] = [];
  for (const [, q] of finalMap) {
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
  return quotes;
}

// ── 內部：CN 報價抓取（含 EastMoney → Tencent fallback） ──────────────────

async function _fetchCNQuotes(
  sources: DataSourceStatus[],
  today: string,
): Promise<IntradayQuote[]> {
  // 1. EastMoney push2（加 try-catch 防止連線超時炸掉整個 refresh）
  const { getEastMoneyRealtime } = await import('./EastMoneyRealtime');
  let cnMap: Map<string, { code: string; name: string; open: number; high: number; low: number; close: number; volume: number; prevClose?: number }>;

  try {
    const { result: emMap, elapsedMs: emMs } = await timedFetch(() => getEastMoneyRealtime());
    cnMap = emMap;
    sources.push({
      source: 'EastMoney',
      success: emMap.size > 0,
      quoteCount: emMap.size,
      responseTimeMs: emMs,
      timestamp: new Date().toISOString(),
    });
  } catch (emErr) {
    console.error(`[IntradayCache] CN EastMoney 連線失敗:`, emErr instanceof Error ? emErr.message : emErr);
    cnMap = new Map();
    sources.push({
      source: 'EastMoney',
      success: false,
      quoteCount: 0,
      errorMessage: emErr instanceof Error ? emErr.message : String(emErr),
      responseTimeMs: 0,
      timestamp: new Date().toISOString(),
    });
  }

  // 2. EastMoney 返回不足 → 騰訊補充（0 筆=完全替代，<1500=補充缺失）
  const CN_MIN_EXPECTED = 1500; // 預期 3000+ 主板，低於一半視為不足
  if (cnMap.size < CN_MIN_EXPECTED) {
    const reason = cnMap.size === 0 ? '返回 0 筆' : `僅 ${cnMap.size} 筆（預期 3000+）`;
    console.warn(`[IntradayCache] CN EastMoney ${reason}，嘗試騰訊${cnMap.size > 0 ? '補充' : 'fallback'}...`);
    try {
      const { getTencentRealtime } = await import('./TencentRealtime');
      const { CN_STOCKS } = await import('@/lib/scanner/cnStocks');
      const symbols = CN_STOCKS.map(s => s.symbol);
      const { result: tcMap, elapsedMs: tcMs } = await timedFetch(() => getTencentRealtime(symbols));

      if (cnMap.size === 0) {
        // 東財完全失敗 → 用騰訊替代
        cnMap = tcMap;
      } else {
        // 東財部分成功 → 騰訊補充缺失（不覆蓋東財已有的，東財有 prevClose 等更豐富欄位）
        let supplemented = 0;
        for (const [code, quote] of tcMap) {
          if (!cnMap.has(code)) {
            cnMap.set(code, quote);
            supplemented++;
          }
        }
        console.info(`[IntradayCache] CN 騰訊補充 ${supplemented} 筆，總計 ${cnMap.size} 筆`);
      }

      sources.push({
        source: 'Tencent',
        success: tcMap.size > 0,
        quoteCount: tcMap.size,
        responseTimeMs: tcMs,
        timestamp: new Date().toISOString(),
      });
      if (cnMap.size === 0) {
        console.warn(`[IntradayCache] CN 騰訊 fallback 也返回 0 筆`);
      }
    } catch (err) {
      sources.push({
        source: 'Tencent',
        success: false,
        quoteCount: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
        responseTimeMs: 0,
        timestamp: new Date().toISOString(),
      });
      console.warn(`[IntradayCache] CN 騰訊 fallback 失敗:`, err);
    }
  }

  // 3. 讀取 MA Base 以補足 prevClose
  let maBaseMap: Record<string, { closes: number[] }> = {};
  try {
    const maBase = await readMABase('CN', today);
    if (maBase) {
      for (const [sym, entry] of Object.entries(maBase.data)) {
        if (entry.closes.length > 0) {
          maBaseMap[sym] = { closes: entry.closes };
        }
      }
    }
  } catch { /* ignore - MA base 尚不存在 */ }

  // 4. 組裝報價
  const quotes: IntradayQuote[] = [];
  for (const [, q] of cnMap) {
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
    const src = sources.find(s => s.success)?.source ?? 'unknown';
    console.info(`[IntradayCache] CN L2 來源: ${src}, ${quotes.length} 筆`);
  }

  return quotes;
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
