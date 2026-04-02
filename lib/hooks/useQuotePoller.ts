/**
 * Shared quote polling hook — consolidates duplicate 30s polling
 * across BottomPanel and Portfolio page.
 *
 * Usage:
 *   const { prices, refresh, isRefreshing } = useQuotePoller(symbols, { intervalMs: 30_000 });
 */
import { useState, useCallback, useEffect, useRef } from 'react';

export interface QuoteData {
  price: number;
  changePercent: number;
  loading: boolean;
  error?: string;
}

interface UseQuotePollerOptions {
  /** Polling interval in ms (default 30_000) */
  intervalMs?: number;
  /** Whether polling is enabled (default true) */
  enabled?: boolean;
}

// Module-level inflight guard — prevents duplicate fetches when
// multiple components subscribe to the same symbols within the same tick.
let inflightPromise: Promise<void> | null = null;
let inflightSymbols = '';

export function useQuotePoller(
  symbols: string[],
  { intervalMs = 30_000, enabled = true }: UseQuotePollerOptions = {},
) {
  const [prices, setPrices] = useState<Record<string, QuoteData>>({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (symbols.length === 0) return;

    // Dedup: if the same symbols are already being fetched, reuse that promise
    const key = [...symbols].sort().join(',');
    if (inflightPromise && inflightSymbols === key) {
      await inflightPromise;
      return;
    }

    setIsRefreshing(true);
    const doFetch = async () => {
      try {
        const res = await fetch(`/api/portfolio/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
        if (!res.ok) return;
        const json = await res.json();
        const quotes: Array<{ symbol: string; price: number; changePercent: number }> = json.quotes ?? [];
        setPrices(prev => {
          const next = { ...prev };
          for (const q of quotes) {
            if (q.price > 0) {
              next[q.symbol] = { price: q.price, changePercent: q.changePercent, loading: false };
            }
          }
          return next;
        });
      } catch {
        // Ignore polling errors
      } finally {
        setIsRefreshing(false);
        inflightPromise = null;
        inflightSymbols = '';
      }
    };

    inflightSymbols = key;
    inflightPromise = doFetch();
    await inflightPromise;
  }, [symbols]);

  // Auto-poll with visibility pause
  useEffect(() => {
    if (!enabled || symbols.length === 0) return;

    const start = () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(refresh, intervalMs);
    };
    const stop = () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    };

    start();

    const handleVisibility = () => {
      if (document.hidden) stop();
      else { refresh(); start(); }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refresh, intervalMs, enabled, symbols]);

  return { prices, refresh, isRefreshing };
}
