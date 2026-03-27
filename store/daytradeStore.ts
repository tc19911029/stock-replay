/**
 * 當沖提示平台 — Zustand Store（即時模式）
 *
 * 兩種模式：
 * 1. 即時模式（預設）— K 線自動更新，無播放按鈕
 * 2. 歷史回放模式 — 手動播放，用於練習驗證
 */

import { create } from 'zustand';
import type {
  IntradayTimeframe,
  IntradayCandle,
  IntradayCandleWithIndicators,
  IntradaySignal,
  MultiTimeframeState,
  DayTradeSession,
  PaperPosition,
  SignalValidation,
  ValidationStatistics,
} from '@/lib/daytrade/types';
import { computeIntradayIndicators } from '@/lib/daytrade/IntradayIndicators';
import { IntradaySignalEngine } from '@/lib/daytrade/IntradaySignalEngine';
import { analyzeMultiTimeframe } from '@/lib/daytrade/MultiTimeframeAnalyzer';
import { PaperTradingEngine } from '@/lib/daytrade/PaperTradingEngine';
import { validateSignal, aggregateValidations } from '@/lib/daytrade/SignalValidator';
import { todayTW, nowISOTW, formatTWTime } from '@/lib/timezone';

// ── Types ────────────────────────────────────────────────────────────────────

type ViewMode = 'live' | 'replay';

interface EndOfDayReport {
  date: string;
  symbol: string;
  stockName: string;
  initialCapital: number;
  finalCapital: number;
  totalPnL: number;
  returnPct: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  trades: Array<{
    action: 'BUY' | 'SELL';
    time: string;
    price: number;
    shares: number;
    pnl?: number;
  }>;
  signals: IntradaySignal[];
  unclosedShares: number;
  unclosedAvgCost: number;
  closingPrice: number;
}

interface DaytradeState {
  // Mode
  viewMode: ViewMode;

  // Symbol & data
  symbol: string;
  stockName: string;
  date: string;
  selectedTimeframe: IntradayTimeframe;
  displayCandles: IntradayCandleWithIndicators[];
  minuteCandles: IntradayCandle[];
  isLoading: boolean;
  error: string | null;

  // Multi-timeframe
  mtfState: MultiTimeframeState | null;

  // Signals
  currentSignals: IntradaySignal[];
  allSignals: IntradaySignal[];
  newSignalAlert: IntradaySignal | null; // 最新觸發的高分訊號（用於閃爍提醒）

  // Paper trading
  session: DayTradeSession | null;
  position: PaperPosition | null;
  initialCapital: number;
  autoTrade: boolean; // 是否根據訊號自動交易

  // Settings
  todayOnly: boolean;
  signalThreshold: number;
  autoRefresh: boolean;
  refreshInterval: number; // 秒

  // Hover
  hoverCandle: IntradayCandleWithIndicators | null;

  // Quote
  latestPrice: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  priceChange: number;
  priceChangePct: number;
  dayVolume: number;
  lastUpdateTime: string;

  // Validation
  validations: SignalValidation[];
  validationStats: ValidationStatistics | null;

  // End of day report
  eodReport: EndOfDayReport | null;

  // Replay mode only
  replayIndex: number;
  isReplaying: boolean;
  replaySpeed: number;

  // Actions
  setSymbol: (s: string) => void;
  setDate: (d: string) => void;
  setTimeframe: (tf: IntradayTimeframe) => void;
  setViewMode: (m: ViewMode) => void;
  setInitialCapital: (c: number) => void;
  setTodayOnly: (v: boolean) => void;
  setSignalThreshold: (v: number) => void;
  setAutoTrade: (v: boolean) => void;
  toggleAutoRefresh: () => void;
  setHoverCandle: (c: IntradayCandleWithIndicators | null) => void;
  loadData: () => Promise<void>;
  paperBuy: (shares: number) => void;
  paperSell: (shares: number) => void;
  closeAll: () => void;
  generateEODReport: () => void;
  clearAlert: () => void;
  runValidation: () => void;

  // Replay-only actions
  startReplay: () => void;
  stopReplay: () => void;
  nextBar: () => void;
  setReplaySpeed: (ms: number) => void;
}

// ── Engine instances ─────────────────────────────────────────────────────────

const signalEngine = new IntradaySignalEngine();
let paperEngine: PaperTradingEngine | null = null;
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let replayTimer: ReturnType<typeof setInterval> | null = null;

async function fetchRealCandles(symbol: string, timeframe: IntradayTimeframe, todayOnly = true): Promise<{ candles: IntradayCandle[]; name: string }> {
  const res = await fetch(`/api/daytrade/intraday-data?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&todayOnly=${todayOnly ? '1' : '0'}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '未知錯誤' }));
    throw new Error(err.error ?? `API 錯誤 ${res.status}`);
  }
  const json = await res.json();
  return { candles: json.candles ?? [], name: json.name ?? '' };
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useDaytradeStore = create<DaytradeState>((set, get) => ({
  // Initial state
  viewMode: 'live',
  symbol: '2330',
  stockName: '',
  date: todayTW(),
  selectedTimeframe: '5m',
  displayCandles: [],
  minuteCandles: [],
  isLoading: false,
  error: null,
  mtfState: null,
  currentSignals: [],
  allSignals: [],
  newSignalAlert: null,
  session: null,
  position: null,
  initialCapital: 1000000,
  autoTrade: false,
  todayOnly: true,
  signalThreshold: 0,
  autoRefresh: false,
  refreshInterval: 30,
  hoverCandle: null,
  latestPrice: 0,
  openPrice: 0,
  highPrice: 0,
  lowPrice: 0,
  priceChange: 0,
  priceChangePct: 0,
  dayVolume: 0,
  lastUpdateTime: '',
  validations: [],
  validationStats: null,
  eodReport: null,
  replayIndex: 0,
  isReplaying: false,
  replaySpeed: 500,

  // ── Setters ──

  setSymbol: (symbol) => set({ symbol }),
  setDate: (date) => set({ date }),
  setViewMode: (viewMode) => {
    if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
    set({ viewMode, isReplaying: false });
  },
  setTimeframe: (tf) => {
    set({ selectedTimeframe: tf });
    setTimeout(() => get().loadData(), 50);
  },
  setInitialCapital: (c) => set({ initialCapital: c }),
  setTodayOnly: (v) => { set({ todayOnly: v }); setTimeout(() => get().loadData(), 50); },
  setSignalThreshold: (v) => set({ signalThreshold: v }),
  setAutoTrade: (v) => set({ autoTrade: v }),
  setHoverCandle: (c) => set({ hoverCandle: c }),
  clearAlert: () => set({ newSignalAlert: null }),

  toggleAutoRefresh: () => {
    const { autoRefresh, refreshInterval } = get();
    if (!autoRefresh) {
      if (autoRefreshTimer) clearInterval(autoRefreshTimer);
      autoRefreshTimer = setInterval(() => { get().loadData(); }, refreshInterval * 1000);
      set({ autoRefresh: true });
    } else {
      if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
      set({ autoRefresh: false });
    }
  },

  // ── Load Data (core) ──

  loadData: async () => {
    const { symbol, selectedTimeframe, initialCapital, todayOnly, allSignals: prevSignals, autoTrade } = get();
    set({ isLoading: true, error: null });

    try {
      const { candles: rawCandles, name: stockName } = await fetchRealCandles(symbol, selectedTimeframe, todayOnly);
      if (rawCandles.length === 0) throw new Error('無分鐘數據，可能非交易時間');

      const displayCandles = computeIntradayIndicators(rawCandles);

      // MTF analysis (try 1m data)
      let minuteCandles = rawCandles;
      let mtfState: MultiTimeframeState | null = null;
      try {
        if (!['1m', '3m'].includes(selectedTimeframe)) {
          const { candles: m1 } = await fetchRealCandles(symbol, '1m', todayOnly);
          if (m1.length > 0) { minuteCandles = m1; mtfState = analyzeMultiTimeframe(m1); }
        } else {
          mtfState = analyzeMultiTimeframe(rawCandles);
        }
      } catch { /* MTF optional */ }

      // Compute signals
      const allSignals = signalEngine.evaluateAll(displayCandles, selectedTimeframe, mtfState ?? undefined);

      // Detect NEW signals (compare with previous)
      const prevIds = new Set(prevSignals.map(s => s.id));
      const newSigs = allSignals.filter(s => !prevIds.has(s.id) && (s.type === 'BUY' || s.type === 'SELL') && s.score >= 60);
      const newSignalAlert = newSigs.length > 0 ? newSigs[newSigs.length - 1] : null;

      // Quote info
      const today = displayCandles[displayCandles.length - 1]?.time.split('T')[0];
      const todayCandles = displayCandles.filter(c => c.time.split('T')[0] === today);
      const src = todayCandles.length > 0 ? todayCandles : displayCandles;
      const first = src[0];
      const last = src[src.length - 1];
      const openPrice = first.open;
      const latestPrice = last.close;

      // Init paper engine if not exists
      if (!paperEngine) {
        paperEngine = new PaperTradingEngine(symbol, initialCapital, today ?? '');
      }
      paperEngine.updatePrice(latestPrice);

      // Auto-trade: execute new signals
      if (autoTrade && newSigs.length > 0) {
        for (const sig of newSigs) {
          if (sig.type === 'BUY') {
            const shares = Math.floor((initialCapital * 0.1) / latestPrice / 1000) * 1000 || 1000;
            paperEngine.buy(latestPrice, shares, sig.triggeredAt, sig.id);
          } else if (sig.type === 'SELL') {
            const pos = paperEngine.getPosition();
            if (pos && pos.shares > 0) {
              paperEngine.sell(latestPrice, pos.shares, sig.triggeredAt, sig.id);
            }
          }
        }
      }

      set({
        minuteCandles,
        displayCandles,
        mtfState,
        stockName,
        date: today ?? get().date,
        allSignals,
        currentSignals: allSignals,
        newSignalAlert,
        isLoading: false,
        latestPrice,
        openPrice,
        highPrice: Math.max(...src.map(c => c.high)),
        lowPrice: Math.min(...src.map(c => c.low)),
        dayVolume: src.reduce((s, c) => s + c.volume, 0),
        priceChange: latestPrice - openPrice,
        priceChangePct: ((latestPrice - openPrice) / openPrice) * 100,
        lastUpdateTime: formatTWTime(nowISOTW()),
        session: paperEngine?.getSession() ?? null,
        position: paperEngine?.getPosition() ?? null,
      });
    } catch (e) {
      set({ isLoading: false, error: String(e) });
    }
  },

  // ── Paper Trading ──

  paperBuy: (shares) => {
    if (!paperEngine) return;
    const { latestPrice } = get();
    paperEngine.buy(latestPrice, shares, nowISOTW());
    paperEngine.updatePrice(latestPrice);
    set({ session: paperEngine.getSession(), position: paperEngine.getPosition() });
  },

  paperSell: (shares) => {
    if (!paperEngine) return;
    const { latestPrice } = get();
    paperEngine.sell(latestPrice, shares, nowISOTW());
    paperEngine.updatePrice(latestPrice);
    set({ session: paperEngine.getSession(), position: paperEngine.getPosition() });
  },

  closeAll: () => {
    if (!paperEngine) return;
    const { latestPrice } = get();
    paperEngine.closeAllPositions(latestPrice, nowISOTW());
    paperEngine.updatePrice(latestPrice);
    set({ session: paperEngine.getSession(), position: paperEngine.getPosition() });
  },

  // ── End of Day Report ──

  generateEODReport: () => {
    const { session, allSignals, latestPrice, symbol, stockName, date } = get();
    if (!session) return;

    // Close any remaining positions at latest price
    if (paperEngine) {
      const pos = paperEngine.getPosition();
      if (pos && pos.shares > 0) {
        paperEngine.closeAllPositions(latestPrice, `${date}T13:30:00`);
      }
    }

    const finalSession = paperEngine?.getSession() ?? session;
    const totalAsset = finalSession.currentCapital;

    const report: EndOfDayReport = {
      date,
      symbol,
      stockName,
      initialCapital: finalSession.initialCapital,
      finalCapital: totalAsset,
      totalPnL: finalSession.realizedPnL,
      returnPct: ((totalAsset - finalSession.initialCapital) / finalSession.initialCapital) * 100,
      totalTrades: finalSession.trades.length,
      winCount: finalSession.winCount,
      lossCount: finalSession.lossCount,
      winRate: finalSession.trades.length > 0
        ? Math.round((finalSession.winCount / Math.max(1, finalSession.winCount + finalSession.lossCount)) * 100) : 0,
      trades: finalSession.trades.map(t => ({
        action: t.action,
        time: t.timestamp,
        price: t.price,
        shares: t.shares,
        pnl: t.realizedPnL,
      })),
      signals: allSignals,
      unclosedShares: 0,
      unclosedAvgCost: 0,
      closingPrice: latestPrice,
    };

    set({ eodReport: report, session: paperEngine?.getSession() ?? null, position: paperEngine?.getPosition() ?? null });
  },

  // ── Validation ──

  runValidation: () => {
    const { allSignals, displayCandles } = get();
    if (allSignals.length === 0 || displayCandles.length === 0) return;
    const validations: SignalValidation[] = [];
    for (const signal of allSignals) {
      const idx = displayCandles.findIndex(c => c.time === signal.triggeredAt);
      if (idx < 0) continue;
      validations.push(validateSignal(signal, displayCandles, idx));
    }
    set({ validations, validationStats: aggregateValidations(validations) });
  },

  // ── Replay Mode Actions (only for viewMode === 'replay') ──

  startReplay: () => {
    const { replaySpeed } = get();
    set({ isReplaying: true, replayIndex: 0 });
    if (replayTimer) clearInterval(replayTimer);
    replayTimer = setInterval(() => {
      const { replayIndex, displayCandles, selectedTimeframe, mtfState } = get();
      if (replayIndex >= displayCandles.length - 1) { get().stopReplay(); return; }
      const next = replayIndex + 1;
      const visible = displayCandles.slice(0, next + 1);
      const signals = signalEngine.evaluate(visible, next, selectedTimeframe, mtfState ?? undefined);
      const curr = displayCandles[next];
      if (paperEngine) paperEngine.updatePrice(curr.close);
      set(s => ({
        replayIndex: next,
        currentSignals: [...s.currentSignals, ...signals],
        allSignals: [...s.allSignals, ...signals],
        latestPrice: curr.close,
        session: paperEngine?.getSession() ?? s.session,
        position: paperEngine?.getPosition() ?? s.position,
      }));
    }, replaySpeed);
  },

  stopReplay: () => {
    if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
    set({ isReplaying: false });
  },

  nextBar: () => {
    const { replayIndex, displayCandles, selectedTimeframe, mtfState } = get();
    if (replayIndex >= displayCandles.length - 1) return;
    const next = replayIndex + 1;
    const visible = displayCandles.slice(0, next + 1);
    const signals = signalEngine.evaluate(visible, next, selectedTimeframe, mtfState ?? undefined);
    const curr = displayCandles[next];
    if (paperEngine) paperEngine.updatePrice(curr.close);
    set(s => ({
      replayIndex: next,
      currentSignals: [...s.currentSignals, ...signals],
      latestPrice: curr.close,
      session: paperEngine?.getSession() ?? s.session,
      position: paperEngine?.getPosition() ?? s.position,
    }));
  },

  setReplaySpeed: (ms) => set({ replaySpeed: ms }),
}));
