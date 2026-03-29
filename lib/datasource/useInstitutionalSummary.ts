'use client';

import { useState, useEffect, useRef } from 'react';

export interface InstitutionalSummary {
  foreignNet5d: number;
  trustNet5d: number;
  totalNet5d: number;
  consecutiveForeignBuy: number;
}

const cache = new Map<string, { data: InstitutionalSummary | null; fetchedAt: number }>();
const TTL = 30 * 60 * 1000;  // 30 min client-side cache

/**
 * Fetches FinMind 5-day institutional summary for a single stock.
 * Returns null while loading or on error.
 */
export function useInstitutionalSummary(ticker: string | null) {
  const [data, setData] = useState<InstitutionalSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!ticker) { setData(null); return; }
    const key = ticker.replace(/\.(TW|TWO)$/i, '');
    const hit = cache.get(key);
    if (hit && Date.now() - hit.fetchedAt < TTL) {
      setData(hit.data);
      return;
    }
    setLoading(true);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetch(`/api/institutional/${key}?mode=summary`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(json => {
        const d = json.ok ? (json.data as InstitutionalSummary | null) : null;
        cache.set(key, { data: d, fetchedAt: Date.now() });
        setData(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [ticker]);

  return { data, loading };
}

/**
 * Batch-fetches institutional summaries for a list of tickers.
 * Returns a Map<cleanSymbol, InstitutionalSummary | null>.
 * Concurrency capped at 5 parallel requests.
 */
export async function fetchInstitutionalBatch(
  tickers: string[],
): Promise<Map<string, InstitutionalSummary | null>> {
  const result = new Map<string, InstitutionalSummary | null>();
  const toFetch: string[] = [];

  for (const t of tickers) {
    const key = t.replace(/\.(TW|TWO)$/i, '');
    const hit = cache.get(key);
    if (hit && Date.now() - hit.fetchedAt < TTL) {
      result.set(key, hit.data);
    } else {
      toFetch.push(key);
    }
  }

  // Process in batches of 5
  for (let i = 0; i < toFetch.length; i += 5) {
    const batch = toFetch.slice(i, i + 5);
    await Promise.all(batch.map(async key => {
      try {
        const res = await fetch(`/api/institutional/${key}?mode=summary`);
        const json = await res.json();
        const d = json.ok ? (json.data as InstitutionalSummary | null) : null;
        cache.set(key, { data: d, fetchedAt: Date.now() });
        result.set(key, d);
      } catch {
        result.set(key, null);
      }
    }));
  }
  return result;
}
