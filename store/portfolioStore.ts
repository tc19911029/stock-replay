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
  /** P1-2: 匯出持倉為 JSON（下載檔案） */
  exportJSON: () => void;
  /** P1-2: 從 JSON 匯入持倉（合併或覆蓋） */
  importJSON: (json: string, mode?: 'merge' | 'replace') => boolean;
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
      exportJSON: () => {
        const { holdings } = usePortfolioStore.getState();
        const data = JSON.stringify({ version: 1, holdings, exportedAt: new Date().toISOString() }, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `portfolio-backup-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
      },
      importJSON: (json: string, mode = 'merge') => {
        try {
          const parsed = JSON.parse(json);
          const imported: PortfolioHolding[] = parsed.holdings ?? parsed;
          if (!Array.isArray(imported)) return false;
          // 基本驗證
          const valid = imported.every(h =>
            typeof h.symbol === 'string' && typeof h.shares === 'number' && typeof h.costPrice === 'number'
          );
          if (!valid) return false;
          set(s => {
            if (mode === 'replace') {
              return { holdings: imported.map(h => ({ ...h, id: h.id ?? Date.now().toString() + Math.random() })) };
            }
            // merge: 新增不重複的（依 symbol + buyDate 判斷）
            const existingKeys = new Set(s.holdings.map(h => `${h.symbol}_${h.buyDate}`));
            const newHoldings = imported
              .filter(h => !existingKeys.has(`${h.symbol}_${h.buyDate}`))
              .map(h => ({ ...h, id: Date.now().toString() + Math.random() }));
            return { holdings: [...s.holdings, ...newHoldings] };
          });
          return true;
        } catch {
          return false;
        }
      },
    }),
    { name: 'portfolio-v1' }
  )
);
