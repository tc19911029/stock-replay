import { create } from 'zustand';
import {
  CandleWithIndicators,
  AccountState,
  AccountMetrics,
  RuleSignal,
  PerformanceStats,
  StockInfo,
  ChartSignalMarker,
} from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { loadMockData } from '@/lib/data/mockData';
import {
  createAccount,
  executeBuy,
  executeSell,
  computeMetrics,
  sharesFromPercent,
} from '@/lib/engines/tradeEngine';
import {
  TrendState,
  TrendPosition,
  SixConditionsResult,
} from '@/lib/analysis/trendAnalysis';
import { type ProhibitionResult } from '@/lib/rules/entryProhibitions';
import { type ShortSixConditionsResult } from '@/lib/analysis/shortAnalysis';
import { type WinnerPatternResult } from '@/lib/rules/winnerPatternRules';

// ── Extracted modules ──────────────────────────────────────────────────────────
import { buildState } from './replay/buildState';
import {
  precomputeMarkers,
  clearCachedMarkers,
  getCachedMarkers,
  setSignalStrengthMin as _setStrengthMin,
} from './replay/signalCache';

const INITIAL_CAPITAL = 1_000_000;

const EMPTY_STATS: PerformanceStats = {
  totalTrades: 0, winCount: 0, lossCount: 0, winRate: 0,
  totalRealizedPnL: 0, totalReturnRate: 0, equityCurve: [],
};

interface ReplayStore {
  // ── Data ──────────────────────────────────────────────────
  allCandles: CandleWithIndicators[];
  currentIndex: number;
  visibleCandles: CandleWithIndicators[];
  currentStock: StockInfo | null;
  currentInterval: string;
  /** 從掃描結果載入時的訊號日，切換週期時用來定位 */
  targetDate: string | null;
  isLoadingStock: boolean;

  // ── Playback ──────────────────────────────────────────────
  isPlaying: boolean;
  playSpeed: number;

  // ── Trading ───────────────────────────────────────────────
  account: AccountState;
  metrics: AccountMetrics;
  stats: PerformanceStats;

  // ── Signals ───────────────────────────────────────────────
  currentSignals: RuleSignal[];
  chartMarkers: ChartSignalMarker[];
  signalStrengthMin: number;

  // ── Analysis ──────────────────────────────────────────────
  trendState: TrendState;
  trendPosition: TrendPosition;
  sixConditions: SixConditionsResult | null;
  prevSixConditions: SixConditionsResult | null;  // 前一根K棒的六條件（用於偵測變化）
  longProhibitions: ProhibitionResult | null;
  shortProhibitions: ProhibitionResult | null;
  shortConditions: ShortSixConditionsResult | null;
  winnerPatterns: WinnerPatternResult | null;

  // ── Actions ───────────────────────────────────────────────
  initData: () => void;
  loadStock: (symbol: string, interval?: string, period?: string, targetDate?: string) => Promise<void>;
  nextCandle: () => void;
  prevCandle: () => void;
  jumpToIndex: (index: number) => void;
  jumpToNextBuySignal: () => void;
  jumpToPrevBuySignal: () => void;
  startPlay: () => void;
  stopPlay: () => void;
  setPlaySpeed: (ms: number) => void;
  resetReplay: () => void;
  buy: (shares: number) => void;
  sell: (shares: number) => void;
  buyPercent: (percent: number) => void;
  sellPercent: (percent: number) => void;
  setSignalStrengthMin: (min: number) => void;
}

/** Always start replay at the latest (rightmost) candle */
function calcStartIndex(candles: CandleWithIndicators[]): number {
  return candles.length - 1;
}

export const useReplayStore = create<ReplayStore>((set, get) => ({
  allCandles: [],
  currentIndex: 0,
  visibleCandles: [],
  currentStock: null,
  currentInterval: '1d',
  targetDate: null,
  isLoadingStock: false,
  isPlaying: false,
  playSpeed: 800,
  account: createAccount(INITIAL_CAPITAL),
  metrics: computeMetrics(createAccount(INITIAL_CAPITAL), 0),
  stats: EMPTY_STATS,
  currentSignals: [],
  chartMarkers: [],
  signalStrengthMin: 2,
  trendState: '盤整' as TrendState,
  trendPosition: '盤整觀望' as TrendPosition,
  sixConditions: null,
  prevSixConditions: null,
  longProhibitions: null,
  shortProhibitions: null,
  shortConditions: null,
  winnerPatterns: null,

  // ── Init with mock data ───────────────────────────────────
  initData: () => {
    const rawCandles = loadMockData();
    const allCandles = computeIndicators(rawCandles);
    precomputeMarkers(allCandles);
    const index = calcStartIndex(allCandles);
    const account = createAccount(INITIAL_CAPITAL);
    set({
      allCandles,
      currentIndex: index,
      currentInterval: '1d',
      targetDate: null,
      account,
      currentStock: { ticker: 'DEMO', name: '範例資料（模擬）' },
      ...buildState(allCandles, index, account),
    });
  },

  // ── Load real stock ──────────────────────────────────────
  loadStock: async (symbol: string, interval = '1d', period?: string, targetDate?: string) => {
    if (symbol === 'mock') {
      get().initData();
      return;
    }

    const defaultPeriod: Record<string, string> = {
      '1m': '5d', '5m': '60d', '15m': '60d', '30m': '60d', '60m': '6mo',
      '1d': '2y', '1wk': '5y', '1mo': '10y',
    };
    const p = period ?? defaultPeriod[interval] ?? '2y';

    set({ isLoadingStock: true, isPlaying: false });
    clearCachedMarkers();
    try {
      const res = await fetch(
        `/api/stock?symbol=${encodeURIComponent(symbol)}&interval=${interval}&period=${p}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? '載入失敗');

      const allCandles = computeIndicators(json.candles);
      if (allCandles.length === 0) throw new Error('資料筆數為 0');

      precomputeMarkers(allCandles);
      let index: number;
      if (targetDate) {
        // Position chart at the target date (scan record date)
        const dateIdx = allCandles.findIndex(c => c.date === targetDate);
        if (dateIdx !== -1) {
          index = dateIdx;
        } else {
          // Fallback: find the closest candle on or before targetDate
          let closest = -1;
          for (let i = allCandles.length - 1; i >= 0; i--) {
            if (allCandles[i].date <= targetDate) { closest = i; break; }
          }
          index = closest !== -1 ? closest : calcStartIndex(allCandles);
        }
      } else {
        index = calcStartIndex(allCandles);
      }
      const account = createAccount(INITIAL_CAPITAL);
      set({
        allCandles,
        currentIndex: index,
        currentInterval: interval,
        targetDate: targetDate ?? null,
        account,
        currentStock: { ticker: json.ticker, name: json.name },
        isLoadingStock: false,
        ...buildState(allCandles, index, account),
      });
    } catch (err) {
      set({ isLoadingStock: false });
      throw err;
    }
  },

  // ── Replay controls ───────────────────────────────────────
  nextCandle: () => {
    const { allCandles, currentIndex, account, sixConditions } = get();
    const next = Math.min(currentIndex + 1, allCandles.length - 1);
    if (next === currentIndex) return;
    set({ currentIndex: next, prevSixConditions: sixConditions, ...buildState(allCandles, next, account) });
  },

  prevCandle: () => {
    const { allCandles, currentIndex, account, sixConditions } = get();
    const prev = Math.max(currentIndex - 1, 0);
    if (prev === currentIndex) return;
    set({ currentIndex: prev, prevSixConditions: sixConditions, ...buildState(allCandles, prev, account) });
  },

  jumpToIndex: (index: number) => {
    const { allCandles, account, sixConditions } = get();
    const clamped = Math.max(0, Math.min(index, allCandles.length - 1));
    set({ currentIndex: clamped, isPlaying: false, prevSixConditions: sixConditions, ...buildState(allCandles, clamped, account) });
  },

  jumpToNextBuySignal: () => {
    const { allCandles, currentIndex } = get();
    const currentDate = allCandles[currentIndex]?.date ?? '';
    const markers = getCachedMarkers();
    const next = markers.find(m =>
      m.date > currentDate && (m.type === 'BUY' || m.type === 'ADD')
    );
    if (next) {
      const idx = allCandles.findIndex(c => c.date === next.date);
      if (idx !== -1) get().jumpToIndex(idx);
    }
  },

  jumpToPrevBuySignal: () => {
    const { allCandles, currentIndex } = get();
    const currentDate = allCandles[currentIndex]?.date ?? '';
    const markers = getCachedMarkers();
    const prev = [...markers].reverse().find(m =>
      m.date < currentDate && (m.type === 'BUY' || m.type === 'ADD')
    );
    if (prev) {
      const idx = allCandles.findIndex(c => c.date === prev.date);
      if (idx !== -1) get().jumpToIndex(idx);
    }
  },

  startPlay: () => set({ isPlaying: true }),
  stopPlay:  () => set({ isPlaying: false }),
  setPlaySpeed: (ms) => set({ playSpeed: ms }),

  resetReplay: () => {
    const { allCandles } = get();
    const index = calcStartIndex(allCandles);
    const account = createAccount(INITIAL_CAPITAL);
    set({
      currentIndex: index,
      account,
      isPlaying: false,
      ...buildState(allCandles, index, account),
    });
  },

  // ── Trade actions ─────────────────────────────────────────
  buy: (shares) => {
    const { allCandles, currentIndex, account } = get();
    const price = allCandles[currentIndex]?.close ?? 0;
    const date  = allCandles[currentIndex]?.date ?? '';
    const newAccount = executeBuy(account, price, shares, date);
    if (!newAccount) return;
    set({ account: newAccount, ...buildState(allCandles, currentIndex, newAccount) });
  },

  sell: (shares) => {
    const { allCandles, currentIndex, account } = get();
    const price = allCandles[currentIndex]?.close ?? 0;
    const date  = allCandles[currentIndex]?.date ?? '';
    const newAccount = executeSell(account, price, shares, date);
    if (!newAccount) return;
    set({ account: newAccount, ...buildState(allCandles, currentIndex, newAccount) });
  },

  buyPercent: (percent) => {
    const { metrics, allCandles, currentIndex } = get();
    const price = allCandles[currentIndex]?.close ?? 0;
    if (price <= 0) return;
    const shares = sharesFromPercent(metrics.cash, price, percent);
    if (shares > 0) get().buy(shares);
  },

  sellPercent: (percent) => {
    const { account } = get();
    const shares = Math.floor(account.shares * percent);
    if (shares > 0) get().sell(shares);
  },

  setSignalStrengthMin: (min) => {
    _setStrengthMin(min);
    const { allCandles, currentIndex, account } = get();
    if (allCandles.length > 0) {
      precomputeMarkers(allCandles);
      set({
        signalStrengthMin: min,
        ...buildState(allCandles, currentIndex, account),
      });
    } else {
      set({ signalStrengthMin: min });
    }
  },
}));
