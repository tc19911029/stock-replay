// lib/datasource/MemoryCache.ts

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  lastAccessed: number;
}

/** Default maximum number of entries before LRU eviction kicks in */
const DEFAULT_MAX_SIZE = 500;

/**
 * 記憶體快取 — TTL + LRU 驅逐策略
 *
 * - TTL: 過期自動清除
 * - LRU: 超過 maxSize 時驅逐最久未存取的 entry
 * - 定期清理過期 entry 防止記憶體洩漏
 */
export class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private readonly maxSize: number;
  private lastCleanup = 0;
  private static readonly CLEANUP_INTERVAL = 60_000; // 1 minute

  constructor(maxSize = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  /**
   * 取得快取資料，若不存在或已過期則回傳 null
   */
  get<T>(key: string): T | null {
    this.maybeCleanup();
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // Update last accessed time for LRU
    entry.lastAccessed = Date.now();
    return entry.data as T;
  }

  /**
   * 設定快取資料
   * @param ttlMs TTL（毫秒），預設 5 分鐘
   */
  set<T>(key: string, data: T, ttlMs = 5 * 60 * 1000): void {
    // Evict LRU entries if at capacity
    if (!this.store.has(key) && this.store.size >= this.maxSize) {
      this.evictLRU();
    }
    const now = Date.now();
    this.store.set(key, { data, expiresAt: now + ttlMs, lastAccessed: now });
  }

  /** 清除所有快取 */
  clear(): void {
    this.store.clear();
  }

  /** 回傳快取中的 key 數量 */
  get size(): number {
    return this.store.size;
  }

  /** Remove the least recently used entry */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.store) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }
    if (oldestKey) this.store.delete(oldestKey);
  }

  /** Periodically remove expired entries */
  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < MemoryCache.CLEANUP_INTERVAL) return;
    this.lastCleanup = now;
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }
}

/** 全域單例快取（server-side，每次 server restart 重置） */
export const globalCache = new MemoryCache();
