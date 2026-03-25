import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface WatchlistItem {
  symbol: string;
  name: string;
  addedAt: string;
}

interface WatchlistStore {
  items: WatchlistItem[];
  add: (symbol: string, name: string) => void;
  remove: (symbol: string) => void;
  has: (symbol: string) => boolean;
}

export const useWatchlistStore = create<WatchlistStore>()(
  persist(
    (set, get) => ({
      items: [],
      add: (symbol, name) => {
        if (!get().has(symbol)) {
          set(s => ({ items: [...s.items, { symbol, name, addedAt: new Date().toISOString() }] }));
        }
      },
      remove: (symbol) => set(s => ({ items: s.items.filter(i => i.symbol !== symbol) })),
      has: (symbol) => get().items.some(i => i.symbol === symbol),
    }),
    { name: 'watchlist-v1' }
  )
);
