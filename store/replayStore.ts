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
import { RuleEngine, ruleEngine } from '@/lib/rules/ruleEngine';
import {
  detectTrend,
  detectTrendPosition,
  evaluateSixConditions,
  TrendState,
  TrendPosition,
  SixConditionsResult,
} from '@/lib/analysis/trendAnalysis';
import { computeSurgeScore, SurgeScoreResult } from '@/lib/analysis/surgeScore';
import { checkLongProhibitions, checkShortProhibitions, type ProhibitionResult } from '@/lib/rules/entryProhibitions';
import { evaluateShortSixConditions, type ShortSixConditionsResult } from '@/lib/analysis/shortAnalysis';
import { evaluateWinnerPatterns, type WinnerPatternResult } from '@/lib/rules/winnerPatternRules';
import { useSettingsStore } from './settingsStore';

const INITIAL_CAPITAL = 1_000_000;

// ── Module-level signal marker cache (recomputed on data load) ────────────────
let _cachedMarkers: ChartSignalMarker[] = [];
/** 當前策略篩選後的引擎（precomputeMarkers 和 buildState 共用） */
let _activeEngine: RuleEngine = ruleEngine;
/** 信號共振強度最低門檻（多少個群組同意才顯示 marker） */
let _signalStrengthMin = 2;

/**
 * 根據當前策略建立篩選後的 RuleEngine。
 * 如果策略沒有指定 ruleGroups，就用預設的全規則引擎。
 */
function buildFilteredEngine(): RuleEngine {
  const strategy = useSettingsStore.getState().getActiveStrategy();
  if (strategy.ruleGroups && strategy.ruleGroups.length > 0) {
    return new RuleEngine(undefined, strategy.ruleGroups);
  }
  return ruleEngine; // 全開（向後相容）
}

function precomputeMarkers(allCandles: CandleWithIndicators[]): void {
  _activeEngine = buildFilteredEngine();
  const strategy = useSettingsStore.getState().getActiveStrategy();
  const minScore = strategy.thresholds.minScore ?? 4;
  const result: ChartSignalMarker[] = [];

  for (let i = 0; i < allCandles.length; i++) {
    const c = allCandles[i];

    // ── Trend filter (朱家泓：順勢操作，多頭才買，空頭才賣) ──────────────
    const isBullish = c.ma5 != null && c.ma20 != null && c.ma5 > c.ma20;
    const isBearish = c.ma5 != null && c.ma20 != null && c.ma5 < c.ma20;

    // 用 evaluateDetailed 拿到每個 signal 的 groupId
    const { allSignals } = _activeEngine.evaluateDetailed(allCandles, i);

    // 按方向統計來自幾個不同群組
    const buyGroups = new Set(
      allSignals
        .filter(s => (s.type === 'BUY' || s.type === 'ADD') && isBullish)
        .map(s => s.groupId),
    );
    const sellGroups = new Set(
      allSignals
        .filter(s => (s.type === 'SELL' || s.type === 'REDUCE') && isBearish)
        .map(s => s.groupId),
    );

    const buyStrength = buyGroups.size;
    const sellStrength = sellGroups.size;

    // ── 六大條件過濾（買進方向需過門檻，賣出不限） ──
    if (buyStrength >= _signalStrengthMin) {
      const score = minScore > 1 ? evaluateSixConditions(allCandles, i, strategy.thresholds).totalScore : 6;
      if (score >= minScore) {
        result.push({
          date: c.date,
          type: 'BUY',
          label: `買 ×${buyStrength} (${score}/6)`,
          strength: buyStrength,
        });
      }
    }
    if (sellStrength >= _signalStrengthMin) {
      result.push({
        date: c.date,
        type: 'SELL',
        label: sellStrength >= 3 ? `強賣 ×${sellStrength}` : `賣 ×${sellStrength}`,
        strength: sellStrength,
      });
    }
  }

  _cachedMarkers = result;
}

/**
 * How many bars to show when replay begins.
 * For daily: 120 bars (~6 months visible at start), so user practices from mid-history.
 * For weekly: 60 bars (~15 months). For monthly: 36 bars (3 years).
 */

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
  signalStrengthMin: number;          // 共振門檻（幾個群組同意才顯示）

  // ── Analysis ──────────────────────────────────────────────
  trendState: TrendState;
  trendPosition: TrendPosition;
  sixConditions: SixConditionsResult | null;
  surgeScore: SurgeScoreResult | null;
  // ── Phase 7: 10大戒律 + 做空六條件 ───────────────────────
  longProhibitions: ProhibitionResult | null;
  shortProhibitions: ProhibitionResult | null;
  shortConditions: ShortSixConditionsResult | null;
  // ── Phase 8: 33 種贏家圖像 ───────────────────────────────
  winnerPatterns: WinnerPatternResult | null;

  // ── Actions ───────────────────────────────────────────────
  initData: () => void;
  loadStock: (symbol: string, interval?: string, period?: string) => Promise<void>;
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
  const signals = _activeEngine.evaluate(allCandles, index);
  const visibleCandles = allCandles.slice(0, index + 1);
  const currentDate = allCandles[index]?.date ?? '';
  const chartMarkers = _cachedMarkers.filter(m => m.date <= currentDate);
  const trendState    = detectTrend(allCandles, index);
  const trendPosition = detectTrendPosition(allCandles, index);
  const activeThresholds = useSettingsStore.getState().getActiveStrategy().thresholds;
  const sixConditions = evaluateSixConditions(allCandles, index, activeThresholds);
  const surgeScore = computeSurgeScore(allCandles, index);
  const longProhibitions  = index >= 5 ? checkLongProhibitions(allCandles, index)  : null;
  const shortProhibitions = index >= 5 ? checkShortProhibitions(allCandles, index) : null;
  const shortConditions   = index >= 5 ? evaluateShortSixConditions(allCandles, index) : null;
  const winnerPatterns    = index >= 5 ? evaluateWinnerPatterns(allCandles, index)    : null;
  return { visibleCandles, metrics, stats, currentSignals: signals, chartMarkers, trendState, trendPosition, sixConditions, surgeScore, longProhibitions, shortProhibitions, shortConditions, winnerPatterns };
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
  surgeScore: null,
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
    _cachedMarkers = []; // clear stale markers while loading
    try {
      const res = await fetch(
        `/api/stock?symbol=${encodeURIComponent(symbol)}&interval=${interval}&period=${p}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? '載入失敗');

      const allCandles = computeIndicators(json.candles);
      if (allCandles.length === 0) throw new Error('資料筆數為 0');

      precomputeMarkers(allCandles);
      const index = calcStartIndex(allCandles);
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

  jumpToNextBuySignal: () => {
    const { allCandles, currentIndex } = get();
    const currentDate = allCandles[currentIndex]?.date ?? '';
    const next = _cachedMarkers.find(m =>
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
    const prev = [..._cachedMarkers].reverse().find(m =>
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
    _signalStrengthMin = min;
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
