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

  // ── Polling（盤中自動刷新） ──────────────────────────────
  isPolling: boolean;

  // ── Actions ───────────────────────────────────────────────
  initData: () => void;
  loadStock: (symbol: string, interval?: string, period?: string, targetDate?: string) => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
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

// ── Polling（盤中自動刷新） ──────────────────────────────────
let pollingTimer: ReturnType<typeof setInterval> | null = null;

/** 根據 interval 決定 polling 頻率 (ms) */
function getPollingInterval(interval: string): number {
  switch (interval) {
    case '1m':  return 30_000;  // 30 秒
    case '5m':  return 60_000;  // 1 分鐘
    case '15m': return 90_000;  // 1.5 分鐘
    case '30m': return 120_000; // 2 分鐘
    case '60m': return 180_000; // 3 分鐘
    case '1d':  return 300_000; // 5 分鐘（日K 用即時報價 overlay）
    default:    return 0;       // 週K/月K 不需要 polling
  }
}

export const useReplayStore = create<ReplayStore>((set, get) => ({
  allCandles: [],
  currentIndex: 0,
  visibleCandles: [],
  currentStock: null,
  currentInterval: '1d',
  targetDate: null,
  isLoadingStock: false,
  isPolling: false,
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

    // 切換股票前先停止舊的 polling（ScanChartPanel 等外部呼叫路徑不經過 StockSelector）
    get().stopPolling();

    const defaultPeriod: Record<string, string> = {
      '1m': '5d', '5m': '60d', '15m': '60d', '30m': '60d', '60m': '6mo',
      '1d': '2y', '1wk': '5y', '1mo': '10y',
    };
    const p = period ?? defaultPeriod[interval] ?? '2y';
    const isMinuteInterval = ['1m', '5m', '15m', '30m', '60m'].includes(interval);

    set({ isLoadingStock: true, isPlaying: false });
    clearCachedMarkers();

    /** 共用：把 API 回傳的 json 塞進 store */
    const applyData = (json: { ticker: string; name: string; candles: unknown[] }, showLoading: boolean) => {
      const allCandles = computeIndicators(json.candles as { date: string; open: number; high: number; low: number; close: number; volume: number }[]);
      if (allCandles.length === 0) return false;

      precomputeMarkers(allCandles);
      let index: number;
      if (targetDate) {
        const dateIdx = allCandles.findIndex(c => c.date === targetDate);
        if (dateIdx !== -1) {
          index = dateIdx;
        } else {
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
        ...(showLoading ? { isLoadingStock: false } : {}),
        ...buildState(allCandles, index, account),
      });
      return true;
    };

    try {
      // ── 日K 混合模式：先讀本地秒開 → 背景 API 更新 ──
      if (!isMinuteInterval) {
        // Step 1: 嘗試本地檔案（瞬間回應）
        let localLoaded = false;
        try {
          const localRes = await fetch(
            `/api/stock?symbol=${encodeURIComponent(symbol)}&interval=${interval}&period=${p}&local=1`
          );
          if (localRes.ok) {
            const localJson = await localRes.json();
            if (localJson.candles?.length > 0) {
              localLoaded = applyData(localJson, false);
            }
          }
        } catch {
          // 本地讀取失敗，不影響後續
        }

        // Step 2: 背景打 API 拿最新數據
        const apiRes = await fetch(
          `/api/stock?symbol=${encodeURIComponent(symbol)}&interval=${interval}&period=${p}`
        );
        const apiJson = await apiRes.json();
        if (!apiRes.ok) {
          if (!localLoaded) throw new Error(apiJson.error ?? '載入失敗');
          // API 失敗但本地已載入 → 繼續用本地數據
        } else {
          applyData(apiJson, true);
        }
        if (localLoaded || apiRes.ok) {
          set({ isLoadingStock: false });
          return;
        }
        throw new Error('無法取得數據');
      }

      // ── 分鐘K：直接 API（本地沒有分鐘K數據） ──
      const res = await fetch(
        `/api/stock?symbol=${encodeURIComponent(symbol)}&interval=${interval}&period=${p}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? '載入失敗');

      if (!applyData(json, true)) throw new Error('資料筆數為 0');
    } catch (err) {
      set({ isLoadingStock: false });
      throw err;
    }
  },

  // ── Polling（盤中自動刷新） ──────────────────────────────
  startPolling: () => {
    const { currentStock, currentInterval } = get();
    if (!currentStock || currentStock.ticker === 'DEMO') return;

    // 先清除舊 timer
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }

    const intervalMs = getPollingInterval(currentInterval);
    if (intervalMs <= 0) return; // 週K/月K 不 poll

    set({ isPolling: true });
    const symbol = currentStock.ticker.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const interval = currentInterval;
    const defaultPeriod: Record<string, string> = {
      '1m': '5d', '5m': '60d', '15m': '60d', '30m': '60d', '60m': '6mo',
      '1d': '2y', '1wk': '5y', '1mo': '10y',
    };
    const period = defaultPeriod[interval] ?? '2y';

    pollingTimer = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/stock?symbol=${encodeURIComponent(symbol)}&interval=${interval}&period=${period}`
        );
        if (!res.ok) return;
        const json = await res.json();
        const candles = computeIndicators(json.candles);
        if (candles.length === 0) return;

        // 保留當前位置：如果在最末尾則跟隨更新，否則保持不動
        const { currentIndex, allCandles, account } = get();
        const wasAtEnd = currentIndex >= allCandles.length - 1;
        const newIndex = wasAtEnd ? candles.length - 1 : currentIndex;

        precomputeMarkers(candles);
        set({
          allCandles: candles,
          currentIndex: newIndex,
          ...buildState(candles, newIndex, account),
        });
      } catch {
        // polling 失敗不影響用戶體驗，靜默忽略
      }
    }, intervalMs);
  },

  stopPolling: () => {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
    set({ isPolling: false });
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
