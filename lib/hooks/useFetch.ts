'use client';

/**
 * Lightweight data fetching hook with caching and deduplication.
 *
 * Provides SWR-like behavior without adding a dependency:
 * - In-memory cache with configurable TTL
 * - Request deduplication (inflight tracking)
 * - Auto-refetch on key change
 * - Loading / error / data states
 */

import { useState, useEffect, useRef, useCallback } from 'react';

interface UseFetchOptions {
  /** Cache TTL in milliseconds (default: 5 minutes) */
  ttl?: number;
  /** Skip fetching if true */
  skip?: boolean;
}

interface UseFetchResult<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  refetch: () => void;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// Global cache shared across all hook instances
const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

export function useFetch<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: UseFetchOptions = {},
): UseFetchResult<T> {
  const { ttl = DEFAULT_TTL, skip = false } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);

  const doFetch = useCallback(async () => {
    if (!key || skip) return;

    // Check cache
    const cached = cache.get(key) as CacheEntry<T> | undefined;
    if (cached && Date.now() - cached.timestamp < ttl) {
      setData(cached.data);
      setError(null);
      setIsLoading(false);
      return;
    }

    // Check inflight
    const existing = inflight.get(key);
    if (existing) {
      setIsLoading(true);
      try {
        const result = (await existing) as T;
        if (mountedRef.current) {
          setData(result);
          setError(null);
        }
      } catch (e) {
        if (mountedRef.current) {
          setError(e instanceof Error ? e.message : '載入失敗');
        }
      } finally {
        if (mountedRef.current) setIsLoading(false);
      }
      return;
    }

    // New fetch
    setIsLoading(true);
    setError(null);

    const promise = fetcher();
    inflight.set(key, promise);

    try {
      const result = await promise;
      cache.set(key, { data: result, timestamp: Date.now() });
      if (mountedRef.current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : '載入失敗');
      }
    } finally {
      inflight.delete(key);
      if (mountedRef.current) setIsLoading(false);
    }
  }, [key, skip, ttl, fetcher]);

  useEffect(() => {
    mountedRef.current = true;
    doFetch();
    return () => {
      mountedRef.current = false;
    };
  }, [doFetch]);

  return { data, error, isLoading, refetch: doFetch };
}
