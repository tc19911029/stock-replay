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
import { computeStats } from '@/lib/engines/statsEngine';
import { ruleEngine } from '@/lib/rules/ruleEngine';
import {
  detectTrend,
  detectTrendPosition,
  evaluateSixConditions,
  TrendState,
  TrendPosition,
  SixConditionsResult,
} from '@/lib/analysis/trendAnalysis';

const INITIAL_CAPITAL = 1_000_000;

// ── Module-level signal marker cache (recomputed on data load) ────────────────
let _cachedMarkers: ChartSignalMarker[] = [];

// Priority: SELL > BUY > REDUCE > ADD (one marker per candle)
const MARKER_PRIORITY: Record<string, number> = {
  SELL: 4, BUY: 3, REDUCE: 2, ADD: 1, WATCH: 0,
};

function precomputeMarkers(allCandles: CandleWithIndicators[]): void {
  const result: ChartSignalMarker[] = [];
  for (let i = 0; i < allCandles.length; i++) {
    const c = allCandles[i];

    // ── Trend filter (朱家泓：順勢操作，多頭才買，空頭才賣) ──────────────
    const isBullish = c.ma5 != null && c.ma20 != null && c.ma5 > c.ma20;
    const isBearish = c.ma5 != null && c.ma20 != null && c.ma5 < c.ma20;

    const signals = ruleEngine.evaluate(allCandles, i)
      .filter(s => s.type !== 'WATCH')
      .filter(s => {
        if (s.type === 'BUY' || s.type === 'ADD')    return isBullish;  // 只在多頭買進
        if (s.type === 'SELL' || s.type === 'REDUCE') return isBearish; // 只在空頭賣出
        return true;
      });

    if (signals.length === 0) continue;

    // Pick highest-priority signal for this candle
    const best = signals.reduce((a, b) =>
      (MARKER_PRIORITY[b.type] ?? 0) > (MARKER_PRIORITY[a.type] ?? 0) ? b : a
    );
    result.push({ date: c.date, type: best.type, label: best.label });
  }
  _cachedMarkers = result;
}

/**
 * How many bars to show when replay begins.
 * For daily: 120 bars (~6 months visible at start), so user practices from mid-history.
 * For weekly: 60 bars (~15 months). For monthly: 36 bars (3 years).
 */
const START_BARS: Record<string, number> = {
  '1d':  120,
  '1wk': 60,
  '1mo': 36,
};

interface ReplayStore {
  // ── Data ──────────────────────────────────────────────────
  allCandles: CandleWithIndicators[];
  currentIndex: number;
  visibleCandles: CandleWithIndicators[];
  currentStock: StockInfo | null;
  currentInterval: string;
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
  chartMarkers: ChartSignalMarker[];  // all past signal markers up to currentIndex

  // ── Analysis ──────────────────────────────────────────────
  trendState: TrendState;
  trendPosition: TrendPosition;
  sixConditions: SixConditionsResult | null;

  // ── Actions ───────────────────────────────────────────────
  initData: () => void;
  loadStock: (symbol: string, interval?: string, period?: string) => Promise<void>;
  nextCandle: () => void;
  prevCandle: () => void;
  jumpToIndex: (index: number) => void;
  startPlay: () => void;
  stopPlay: () => void;
  setPlaySpeed: (ms: number) => void;
  resetReplay: () => void;
  buy: (shares: number) => void;
  sell: (shares: number) => void;
  buyPercent: (percent: number) => void;
  sellPercent: (percent: number) => void;
}

const EMPTY_STATS: PerformanceStats = {
  totalTrades: 0, winCount: 0, lossCount: 0, winRate: 0,
  totalRealizedPnL: 0, totalReturnRate: 0, equityCurve: [],
};

function buildState(
  allCandles: CandleWithIndicators[],
  index: number,
  account: AccountState
) {
  const currentPrice = allCandles[index]?.close ?? 0;
  const metrics = computeMetrics(account, currentPrice);
  const stats = computeStats(account, allCandles, index);
  const signals = ruleEngine.evaluate(allCandles, index);
  const visibleCandles = allCandles.slice(0, index + 1);
  const currentDate = allCandles[index]?.date ?? '';
  const chartMarkers = _cachedMarkers.filter(m => m.date <= currentDate);
  const trendState    = detectTrend(allCandles, index);
  const trendPosition = detectTrendPosition(allCandles, index);
  const sixConditions = evaluateSixConditions(allCandles, index);
  return { visibleCandles, metrics, stats, currentSignals: signals, chartMarkers, trendState, trendPosition, sixConditions };
}

/** Start replay at START_BARS from the beginning, but at least 60 bars in */
function calcStartIndex(candles: CandleWithIndicators[], interval: string): number {
  const bars = START_BARS[interval] ?? 120;
  return Math.min(bars - 1, candles.length - 1);
}

export const useReplayStore = create<ReplayStore>((set, get) => ({
  allCandles: [],
  currentIndex: 0,
  visibleCandles: [],
  currentStock: null,
  currentInterval: '1d',
  isLoadingStock: false,
  isPlaying: false,
  playSpeed: 800,
  account: createAccount(INITIAL_CAPITAL),
  metrics: computeMetrics(createAccount(INITIAL_CAPITAL), 0),
  stats: EMPTY_STATS,
  currentSignals: [],
  chartMarkers: [],
  trendState: '盤整' as TrendState,
  trendPosition: '盤整觀望' as TrendPosition,
  sixConditions: null,

  // ── Init with mock data ───────────────────────────────────
  initData: () => {
    const rawCandles = loadMockData();
    const allCandles = computeIndicators(rawCandles);
    precomputeMarkers(allCandles);
    const index = calcStartIndex(allCandles, '1d');
    const account = createAccount(INITIAL_CAPITAL);
    set({
      allCandles,
      currentIndex: index,
      currentInterval: '1d',
      account,
      currentStock: { ticker: 'DEMO', name: '範例資料（模擬）' },
      ...buildState(allCandles, index, account),
    });
  },

  // ── Load real stock from Yahoo Finance ────────────────────
  loadStock: async (symbol: string, interval = '1d', period?: string) => {
    if (symbol === 'mock') {
      get().initData();
      return;
    }

    // Auto pick period based on interval if not specified
    const defaultPeriod: Record<string, string> = {
      '1d': '2y', '1wk': '5y', '1mo': '10y',
    };
    const p = period ?? defaultPeriod[interval] ?? '2y';

    set({ isLoadingStock: true, isPlaying: false });
    try {
      const res = await fetch(
        `/api/stock?symbol=${encodeURIComponent(symbol)}&interval=${interval}&period=${p}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? '載入失敗');

      const allCandles = computeIndicators(json.candles);
      if (allCandles.length === 0) throw new Error('資料筆數為 0');

      precomputeMarkers(allCandles);
      const index = calcStartIndex(allCandles, interval);
      const account = createAccount(INITIAL_CAPITAL);
      set({
        allCandles,
        currentIndex: index,
        currentInterval: interval,
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
    const { allCandles, currentIndex, account } = get();
    const next = Math.min(currentIndex + 1, allCandles.length - 1);
    if (next === currentIndex) return;
    set({ currentIndex: next, ...buildState(allCandles, next, account) });
  },

  prevCandle: () => {
    const { allCandles, currentIndex, account } = get();
    const prev = Math.max(currentIndex - 1, 0);
    if (prev === currentIndex) return;
    set({ currentIndex: prev, ...buildState(allCandles, prev, account) });
  },

  jumpToIndex: (index: number) => {
    const { allCandles, account } = get();
    const clamped = Math.max(0, Math.min(index, allCandles.length - 1));
    set({ currentIndex: clamped, isPlaying: false, ...buildState(allCandles, clamped, account) });
  },

  startPlay: () => set({ isPlaying: true }),
  stopPlay:  () => set({ isPlaying: false }),
  setPlaySpeed: (ms) => set({ playSpeed: ms }),

  resetReplay: () => {
    const { allCandles, currentInterval } = get();
    const index = calcStartIndex(allCandles, currentInterval);
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
}));
