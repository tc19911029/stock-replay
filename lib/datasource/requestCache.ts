/**
 * P1-3: API 請求去重層
 *
 * 當多個組件同時請求相同 URL 時，只發送一次請求。
 * 後續相同請求複用同一個 Promise。
 * TTL 過後自動清除快取，允許新請求。
 */

interface CacheEntry<T> {
  promise: Promise<T>;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

/** 預設 TTL: 5 秒 */
const DEFAULT_TTL_MS = 5_000;

/**
 * 對 fetch 請求進行去重。相同 key 在 TTL 內只發送一次。
 *
 * @param key     快取鍵（通常是完整 URL）
 * @param fetcher 產生 Promise 的函數（只在 cache miss 時呼叫）
 * @param ttlMs   快取有效時間（毫秒）
 */
export function dedupFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
): Promise<T> {
  const now = Date.now();
  const existing = cache.get(key) as CacheEntry<T> | undefined;

  if (existing && now - existing.timestamp < ttlMs) {
    return existing.promise;
  }

  const promise = fetcher().finally(() => {
    // 在 TTL 到期後清除（讓下次請求重新取得最新數據）
    setTimeout(() => {
      const entry = cache.get(key);
      if (entry && entry.promise === promise) {
        cache.delete(key);
      }
    }, ttlMs);
  });

  cache.set(key, { promise, timestamp: now });
  return promise;
}

/** 手動清除某個 key 的快取 */
export function invalidateCache(key: string): void {
  cache.delete(key);
}

/** 清除所有快取 */
export function clearAllCache(): void {
  cache.clear();
}
