'use client';

/**
 * Domain-specific data fetching hooks for stock data.
 *
 * Built on useFetch for caching and deduplication.
 */

import { useCallback } from 'react';
import { useFetch } from './useFetch';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FundamentalsData {
  eps?: number;
  epsYoY?: number;
  grossMargin?: number;
  netMargin?: number;
  pe?: number;
  pb?: number;
  dividendYield?: number;
  revenueMonthly?: Array<{ date: string; revenue: number; mom: number; yoy: number }>;
}

interface ChipData {
  chipScore: number;
  signals: string[];
  foreignNet5d: number;
  trustNet5d: number;
  dealerNet5d: number;
  marginBalance?: number;
  dayTradeRatio?: number;
}

interface NewsItem {
  title: string;
  url: string;
  date: string;
  source: string;
  sentiment?: 'positive' | 'negative' | 'neutral';
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/** Fetch fundamental data for a Taiwan stock */
export function useFundamentals(ticker: string | null) {
  const fetcher = useCallback(async () => {
    const res = await fetch(`/api/fundamentals/${ticker}?mode=full`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<FundamentalsData>;
  }, [ticker]);

  return useFetch<FundamentalsData>(
    ticker ? `fundamentals:${ticker}` : null,
    fetcher,
    { ttl: 24 * 60 * 60 * 1000 }, // 24h cache — fundamentals rarely change
  );
}

/** Fetch chip/institutional data */
export function useChipData(symbol: string | null, date?: string) {
  const fetcher = useCallback(async () => {
    const params = new URLSearchParams();
    if (symbol) params.set('symbol', symbol);
    if (date) params.set('date', date);
    const res = await fetch(`/api/chip?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<ChipData>;
  }, [symbol, date]);

  return useFetch<ChipData>(
    symbol ? `chip:${symbol}:${date ?? 'latest'}` : null,
    fetcher,
    { ttl: 10 * 60 * 1000 }, // 10min cache
  );
}

/** Fetch news for a stock */
export function useNews(ticker: string | null) {
  const fetcher = useCallback(async () => {
    const res = await fetch(`/api/news/${ticker}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.articles ?? data) as NewsItem[];
  }, [ticker]);

  return useFetch<NewsItem[]>(
    ticker ? `news:${ticker}` : null,
    fetcher,
    { ttl: 15 * 60 * 1000 }, // 15min cache
  );
}
