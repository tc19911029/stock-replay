import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface PortfolioHolding {
  id: string;
  symbol: string;
  name: string;
  shares: number;
  costPrice: number;
  buyDate: string;
}

interface PortfolioStore {
  holdings: PortfolioHolding[];
  add: (h: Omit<PortfolioHolding, 'id'>) => void;
  remove: (id: string) => void;
  update: (id: string, h: Partial<Omit<PortfolioHolding, 'id'>>) => void;
}

export const usePortfolioStore = create<PortfolioStore>()(
  persist(
    (set) => ({
      holdings: [],
      add: (h) => set(s => ({
        holdings: [...s.holdings, { ...h, id: Date.now().toString() }],
      })),
      remove: (id) => set(s => ({ holdings: s.holdings.filter(h => h.id !== id) })),
      update: (id, partial) => set(s => ({
        holdings: s.holdings.map(h => h.id === id ? { ...h, ...partial } : h),
      })),
    }),
    { name: 'portfolio-v1' }
  )
);
