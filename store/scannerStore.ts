import { create } from 'zustand';
import { StockScanResult, ScanSession, MarketId } from '@/lib/scanner/types';

interface ScannerStore {
  // ── State ──────────────────────────────────────────────────
  activeMarket: MarketId;
  isScanning: boolean;
  scanProgress: number;      // 0–100
  currentResults: StockScanResult[];
  history: ScanSession[];
  lastScanTime: string | null;
  error: string | null;

  // ── Actions ────────────────────────────────────────────────
  setActiveMarket: (market: MarketId) => void;
  runScan: (market: MarketId) => Promise<void>;
  loadHistory: (market: MarketId) => Promise<void>;
}

export const useScannerStore = create<ScannerStore>((set, get) => ({
  activeMarket:   'TW',
  isScanning:     false,
  scanProgress:   0,
  currentResults: [],
  history:        [],
  lastScanTime:   null,
  error:          null,

  setActiveMarket: (market) => set({ activeMarket: market }),

  runScan: async (market) => {
    set({ isScanning: true, scanProgress: 0, error: null });
    try {
      // Start polling for progress (optimistic)
      const progressInterval = setInterval(() => {
        set(s => ({ scanProgress: Math.min(s.scanProgress + 2, 90) }));
      }, 1000);

      const res = await fetch('/api/scanner/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market }),
      });

      clearInterval(progressInterval);

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? '掃描失敗');
      }

      const json = await res.json();
      set({
        currentResults: json.results ?? [],
        lastScanTime: new Date().toISOString(),
        scanProgress: 100,
      });

      // Refresh history
      await get().loadHistory(market);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '未知錯誤' });
    } finally {
      set({ isScanning: false });
    }
  },

  loadHistory: async (market) => {
    try {
      const res = await fetch(`/api/scanner/results?market=${market}`);
      if (!res.ok) return;
      const json = await res.json();
      set({ history: json.sessions ?? [] });
    } catch {
      // silently ignore
    }
  },
}));
