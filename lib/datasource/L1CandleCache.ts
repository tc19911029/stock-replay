/**
 * L1CandleCache — L1 日K 資料記憶體快取（本地開發專用）
 *
 * 快取策略：懶載（lazy per-file），不做 bulk preload。
 * readCandleFile 讀到後存入 Map；下次同檔直接命中，省磁碟 I/O。
 * writeCandleFile 寫入後呼叫 updateCache 同步更新。
 *
 * 為何移除 bulk preload：
 *   100-300 個平行 readFile + JSON.parse 在 Node.js event loop 跑完前
 *   會讓所有其他 request（Fugle、MIS、走圖 polling）全部 timeout。
 *   懶載模式第一次掃描較慢（磁碟讀取），但伺服器始終保持回應。
 *
 * global 物件確保 HMR 重載後快取不清空，不需重讀已快取的檔案。
 *
 * Vercel 不啟用（IS_VERCEL = true）：Blob 讀取是網路操作，快取反而複雜化。
 */

import type { CandleFileData } from './CandleStorageAdapter';

const IS_VERCEL = !!process.env.VERCEL;

// ── 內部狀態（使用 global 存活於 HMR 重載）──

type L1GlobalCache = {
  _l1Store: Map<string, CandleFileData>;
};

const g = global as typeof global & Partial<L1GlobalCache>;
if (!g._l1Store) g._l1Store = new Map();

const _store = g._l1Store;

// ── 公開 API ────────────────────────────────────────────────────────────────────

/**
 * 取快取資料。未命中回傳 null（呼叫方負責從磁碟讀，再呼叫 updateCache）。
 */
export function getFromCache(symbol: string, market: 'TW' | 'CN'): CandleFileData | null {
  if (IS_VERCEL) return null;
  return _store.get(`${market}/${symbol}`) ?? null;
}

/**
 * 寫入或更新快取 entry（writeCandleFile 寫入後呼叫）。
 */
export function updateCache(symbol: string, market: 'TW' | 'CN', data: CandleFileData): void {
  if (IS_VERCEL) return;
  _store.set(`${market}/${symbol}`, data);
}

/**
 * 刪除特定 entry（若需強制讓下次讀取重新從磁碟取）。
 */
export function invalidateEntry(symbol: string, market: 'TW' | 'CN'): void {
  if (IS_VERCEL) return;
  _store.delete(`${market}/${symbol}`);
}

/**
 * No-op：bulk preload 已停用，保留介面避免呼叫方報錯。
 */
export function triggerPreload(_market: 'TW' | 'CN'): void {
  // Intentionally disabled — bulk preload saturates the event loop
}

/**
 * No-op：bulk preload 已停用，保留介面避免呼叫方報錯。
 */
export async function ensureMarketLoaded(_market: 'TW' | 'CN'): Promise<void> {
  // Intentionally disabled — bulk preload saturates the event loop
}

/** 統計資訊（診斷用） */
export function getCacheStats(): { entries: number; markets: string[] } {
  const markets = new Set<string>();
  for (const key of _store.keys()) {
    markets.add(key.split('/')[0]);
  }
  return {
    entries: _store.size,
    markets: [...markets],
  };
}
