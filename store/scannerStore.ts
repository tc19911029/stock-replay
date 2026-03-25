import { create } from 'zustand';
import { StockScanResult, ScanSession, MarketId } from '@/lib/scanner/types';

// Stock names for fake per-stock progress display (matches TaiwanScanner list)
const TW_STOCK_NAMES = [
  '台積電','聯發科','日月光投控','聯電','聯詠','瑞昱','矽力','華邦電','力積電','旺宏',
  '南亞科','京元電子','創意','力成','信驊','同欣電','環球晶','中美晶','鴻海','廣達',
  '台達電','緯穎','緯創','和碩','英業達','研華','臻鼎','光寶科','聯強','奇鋐',
  '川湖','台光電','欣興','南電','華碩','技嘉','宏碁','可成','友達','群創',
  '大立光','致茂','億光','中信金','國泰金','兆豐金','玉山金','富邦金','元大金','第一金',
  '合庫金','華南金','台新金','開發金','永豐金','新光金','中華電','台灣大','遠傳','南亞',
  '台塑','台塑化','台化','中鋼','台泥','亞泥','大成鋼','統一超','統一','和泰車',
  '上銀','亞德客','長榮','陽明','萬海','華航','長榮航','儒鴻','聚陽','燿華',
  '台燿','嘉澤','豐泰','裕融','智原','晶心科','采鈺','祥碩','台表科','晶豪科',
  '合一','旭隼','零壹','天鈺','北極星藥業','卓越','精測','宏達電','光寶科','聯強',
];
const CN_STOCK_NAMES = [
  '寧德時代','貴州茅台','工商銀行','中國平安','招商銀行','恆瑞醫藥','美的集團',
  '格力電器','五糧液','萬科A','中國建築','比亞迪','海天味業','農業銀行','中國銀行',
  '建設銀行','中國人壽','中國石化','中石油','中遠海控',
];

interface ScannerStore {
  activeMarket: MarketId;
  isScanning: boolean;
  scanProgress: number;
  scanningStock: string;        // current stock being scanned (display only)
  scanningIndex: number;        // e.g. 12
  scanningTotal: number;        // e.g. 50
  currentResults: StockScanResult[];
  history: ScanSession[];
  lastScanTime: string | null;
  error: string | null;

  setActiveMarket: (market: MarketId) => void;
  runScan: (market: MarketId) => Promise<void>;
  loadHistory: (market: MarketId) => Promise<void>;
}

export const useScannerStore = create<ScannerStore>((set, get) => ({
  activeMarket:   'TW',
  isScanning:     false,
  scanProgress:   0,
  scanningStock:  '',
  scanningIndex:  0,
  scanningTotal:  100,
  currentResults: [],
  history:        [],
  lastScanTime:   null,
  error:          null,

  setActiveMarket: (market) => set({ activeMarket: market }),

  runScan: async (market) => {
    const names = market === 'TW' ? TW_STOCK_NAMES : CN_STOCK_NAMES;
    const total = names.length;
    set({ isScanning: true, scanProgress: 0, scanningStock: '', scanningIndex: 0, scanningTotal: total, error: null });

    let stockIdx = 0;
    // Cycle through stock names to simulate per-stock progress
    const progressInterval = setInterval(() => {
      stockIdx = Math.min(stockIdx + 1, total - 1);
      const pct = Math.round((stockIdx / total) * 90);
      set({ scanProgress: pct, scanningStock: names[stockIdx], scanningIndex: stockIdx + 1 });
    }, market === 'TW' ? 1800 : 1500);  // approx timing per stock

    try {
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
        scanningStock: '',
      });
      await get().loadHistory(market);
    } catch (err) {
      clearInterval(progressInterval);
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
    } catch { /* silently ignore */ }
  },
}));
