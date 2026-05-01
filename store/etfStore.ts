/**
 * ETF 追蹤器 UI 狀態（不持久化，資料皆從 server 讀取）
 */
import { create } from 'zustand';
import type { PeriodKey } from '@/lib/etf/performanceCalc';

export type ETFTab = 'performance' | 'changes' | 'consensus' | 'tracking';

interface ETFStore {
  activeTab: ETFTab;
  selectedEtfCode: string | null;
  performancePeriod: PeriodKey;
  trackingShowOpen: boolean;
  consensusMinEtfs: number;
  setActiveTab: (tab: ETFTab) => void;
  setSelectedEtfCode: (code: string | null) => void;
  setPerformancePeriod: (period: PeriodKey) => void;
  setTrackingShowOpen: (v: boolean) => void;
  setConsensusMinEtfs: (n: number) => void;
}

export const useETFStore = create<ETFStore>((set) => ({
  activeTab: 'performance',
  selectedEtfCode: null,
  performancePeriod: 'ytd',
  trackingShowOpen: true,
  consensusMinEtfs: 2,
  setActiveTab: (activeTab) => set({ activeTab }),
  setSelectedEtfCode: (selectedEtfCode) => set({ selectedEtfCode }),
  setPerformancePeriod: (performancePeriod) => set({ performancePeriod }),
  setTrackingShowOpen: (trackingShowOpen) => set({ trackingShowOpen }),
  setConsensusMinEtfs: (consensusMinEtfs) => set({ consensusMinEtfs }),
}));
