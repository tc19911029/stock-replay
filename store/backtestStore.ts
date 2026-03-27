import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  MarketId, StockScanResult, StockForwardPerformance, BacktestSession,
} from '@/lib/scanner/types';
import { calcBacktestSummary } from '@/lib/backtest/ForwardAnalyzer';
import {
  BacktestTrade, BacktestStats, BacktestStrategyParams,
  DEFAULT_STRATEGY, runBatchBacktest, runBatchBacktestWithCapital, calcBacktestStats,
  CapitalConstraints, DEFAULT_CAPITAL,
} from '@/lib/backtest/BacktestEngine';
import {
  WalkForwardResult, WalkForwardSession, runWalkForward as _runWalkForward,
} from '@/lib/backtest/WalkForwardTest';

// ── Types ──────────────────────────────────────────────────────────────────────

export type BacktestHorizon = 'open' | 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd10' | 'd20';

export interface BacktestSummary {
  count: number; wins: number; losses: number;
  winRate: number; avgReturn: number;
  median: number; maxGain: number; maxLoss: number;
}

// Re-export so page components can import from the store
export type { CapitalConstraints, WalkForwardResult };

export interface WalkForwardConfig {
  trainSize: number;  // 訓練窗口 session 數
  testSize:  number;  // 測試窗口 session 數
  stepSize:  number;  // 每步滾動 session 數
}

interface BacktestState {
  // controls
  market:              MarketId;
  scanDate:            string;
  strategy:            BacktestStrategyParams;
  useCapitalMode:      boolean;
  capitalConstraints:  CapitalConstraints;

  // scan phase
  isScanning:   boolean;
  scanProgress: number;
  scanError:    string | null;
  scanResults:  StockScanResult[];

  // forward phase
  isFetchingForward: boolean;
  forwardError:  string | null;
  performance:   StockForwardPerformance[];

  // engine phase (v2 — strict backtest)
  trades:           BacktestTrade[];
  stats:            BacktestStats | null;
  skippedByCapital: number;      // 資本限制排除數
  finalCapital:     number | null;
  capitalReturn:    number | null;

  // history
  sessions: BacktestSession[];

  // walk-forward
  walkForwardConfig:  WalkForwardConfig;
  walkForwardResult:  WalkForwardResult | null;
  isRunningWF:        boolean;

  // actions
  setMarket:              (m: MarketId) => void;
  setScanDate:            (d: string)   => void;
  setStrategy:            (s: Partial<BacktestStrategyParams>) => void;
  setCapitalConstraints:  (c: Partial<CapitalConstraints>) => void;
  toggleCapitalMode:      () => void;
  setWalkForwardConfig:   (c: Partial<WalkForwardConfig>) => void;
  computeWalkForward:     () => void;
  runBacktest:            () => Promise<void>;
  loadSession:            (id: string)  => void;
  clearCurrent:           () => void;

  // helpers (legacy horizon stats)
  getSummary: (horizon: BacktestHorizon) => BacktestSummary | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function todayMinus1(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useBacktestStore = create<BacktestState>()(
  persist(
    (set, get) => ({
      market:             'TW',
      scanDate:           todayMinus1(),
      strategy:           DEFAULT_STRATEGY,
      useCapitalMode:     false,
      capitalConstraints: DEFAULT_CAPITAL,
      walkForwardConfig:  { trainSize: 3, testSize: 1, stepSize: 1 },
      walkForwardResult:  null,
      isRunningWF:        false,

      isScanning:   false,
      scanProgress: 0,
      scanError:    null,
      scanResults:  [],

      isFetchingForward: false,
      forwardError:  null,
      performance:   [],

      trades:           [],
      stats:            null,
      skippedByCapital: 0,
      finalCapital:     null,
      capitalReturn:    null,

      sessions: [],

      setMarket:             (market)   => set({ market }),
      setScanDate:           (scanDate) => set({ scanDate }),
      setStrategy:           (partial)  => set(s => ({ strategy: { ...s.strategy, ...partial } })),
      setCapitalConstraints: (partial)  => set(s => ({ capitalConstraints: { ...s.capitalConstraints, ...partial } })),
      toggleCapitalMode:     ()         => set(s => ({ useCapitalMode: !s.useCapitalMode })),
      setWalkForwardConfig:  (partial)  => set(s => ({ walkForwardConfig: { ...s.walkForwardConfig, ...partial } })),

      computeWalkForward: () => {
        const { sessions, market, strategy, walkForwardConfig } = get();

        // 把歷史 session 轉為 WalkForwardSession 格式
        const wfSessions: WalkForwardSession[] = sessions
          .filter(s =>
            s.market === market &&
            s.scanResults.length > 0 &&
            s.performance.length > 0,
          )
          .sort((a, b) => a.scanDate.localeCompare(b.scanDate))
          .map(s => ({
            date: s.scanDate,
            scanResults: s.scanResults,
            forwardCandlesMap: Object.fromEntries(
              s.performance.map(p => [p.symbol, p.forwardCandles]),
            ),
          }));

        const minRequired = walkForwardConfig.trainSize + walkForwardConfig.testSize;
        if (wfSessions.length < minRequired) return;

        set({ isRunningWF: true });
        // 使用 setTimeout 讓 UI 先更新再執行計算（可能略耗時）
        setTimeout(() => {
          const result = _runWalkForward({
            sessions:  wfSessions,
            trainSize: walkForwardConfig.trainSize,
            testSize:  walkForwardConfig.testSize,
            stepSize:  walkForwardConfig.stepSize,
            strategy,
          });
          set({ walkForwardResult: result, isRunningWF: false });
        }, 0);
      },

      clearCurrent: () => set({
        scanResults: [], performance: [], trades: [], stats: null,
        skippedByCapital: 0, finalCapital: null, capitalReturn: null,
        scanError: null, forwardError: null,
        isScanning: false, isFetchingForward: false,
      }),

      getSummary: (horizon) => {
        const { performance } = get();
        if (!performance.length) return null;
        return calcBacktestSummary(performance, horizon) as BacktestSummary | null;
      },

      runBacktest: async () => {
        const { market, scanDate, strategy, useCapitalMode, capitalConstraints } = get();

        // ── Phase 1: Get stock list ──────────────────────────────────────────
        set({ isScanning: true, scanProgress: 5, scanError: null,
              scanResults: [], performance: [], trades: [], stats: null });

        let stocks: Array<{ symbol: string; name: string }>;
        try {
          const listRes = await fetch(`/api/scanner/list?market=${market}`);
          if (!listRes.ok) throw new Error('無法取得股票清單');
          const listJson = await listRes.json() as { stocks: Array<{ symbol: string; name: string }> };
          stocks = listJson.stocks ?? [];
        } catch (e) {
          set({ isScanning: false, scanError: String(e) });
          return;
        }

        set({ scanProgress: 15 });

        // ── Phase 2: Split into 2 chunks, scan in parallel ───────────────────
        const half   = Math.ceil(stocks.length / 2);
        const chunk1 = stocks.slice(0, half);
        const chunk2 = stocks.slice(half);

        const scanChunk = async (chunk: typeof stocks) => {
          const res = await fetch('/api/backtest/scan', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ market, date: scanDate, stocks: chunk }),
          });
          if (!res.ok) throw new Error(`掃描失敗 (${res.status})`);
          const json = await res.json() as { results?: StockScanResult[]; error?: string };
          if (json.error) throw new Error(json.error);
          return json.results ?? [];
        };

        set({ scanProgress: 30 });

        const [r1, r2] = await Promise.allSettled([scanChunk(chunk1), scanChunk(chunk2)]);

        if (r1.status === 'rejected' && r2.status === 'rejected') {
          set({ isScanning: false, scanError: `掃描失敗：${r1.reason}` });
          return;
        }

        const combined: StockScanResult[] = [
          ...(r1.status === 'fulfilled' ? r1.value : []),
          ...(r2.status === 'fulfilled' ? r2.value : []),
        ].sort((a, b) =>
          b.sixConditionsScore !== a.sixConditionsScore
            ? b.sixConditionsScore - a.sixConditionsScore
            : b.changePercent - a.changePercent
        );

        set({ scanResults: combined, isScanning: false, scanProgress: 100 });

        if (combined.length === 0) return;

        // ── Phase 3: Forward performance ─────────────────────────────────────
        set({ isFetchingForward: true, forwardError: null });

        try {
          const forwardPayload = combined.map(r => ({
            symbol:    r.symbol,
            name:      r.name,
            scanPrice: r.price,
          }));
          const fwdRes = await fetch('/api/backtest/forward', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ scanDate, stocks: forwardPayload }),
          });
          if (!fwdRes.ok) throw new Error('無法取得後續績效資料');
          const fwdJson = await fwdRes.json() as { performance?: StockForwardPerformance[] };
          const performance = fwdJson.performance ?? [];

          // ── Phase 4: Run strict BacktestEngine ────────────────────────────
          // Build forward candles map: symbol → ForwardCandle[]
          const candlesMap: Record<string, typeof performance[0]['forwardCandles']> = {};
          for (const p of performance) {
            candlesMap[p.symbol] = p.forwardCandles;
          }

          let trades: BacktestTrade[];
          let skippedCount: number;
          let skippedByCapital = 0;
          let finalCapital: number | null = null;
          let capitalReturn: number | null = null;

          if (useCapitalMode) {
            const result     = runBatchBacktestWithCapital(combined, candlesMap, strategy, capitalConstraints);
            trades           = result.trades;
            skippedCount     = result.skippedCount;
            skippedByCapital = result.skippedByCapital;
            finalCapital     = result.finalCapital;
            capitalReturn    = result.capitalReturn;
          } else {
            const result = runBatchBacktest(combined, candlesMap, strategy);
            trades       = result.trades;
            skippedCount = result.skippedCount;
          }

          const stats = calcBacktestStats(trades, skippedCount);

          // ── Save session ──────────────────────────────────────────────────
          const session: BacktestSession = {
            id:          `${market}-${scanDate}-${Date.now()}`,
            market,
            scanDate,
            createdAt:   new Date().toISOString(),
            scanResults: combined,
            performance,
            trades,
            stats:       stats ?? undefined,
            strategyVersion: `holdDays=${strategy.holdDays},sl=${strategy.stopLoss ?? 'off'},tp=${strategy.takeProfit ?? 'off'}`,
          };

          set(s => ({
            performance,
            trades,
            stats,
            skippedByCapital,
            finalCapital,
            capitalReturn,
            isFetchingForward: false,
            sessions: [session, ...s.sessions].slice(0, 20),
          }));
        } catch (e) {
          set({ isFetchingForward: false, forwardError: String(e) });
        }
      },

      loadSession: (id) => {
        const session = get().sessions.find(s => s.id === id);
        if (!session) return;
        set({
          market:      session.market,
          scanDate:    session.scanDate,
          scanResults: session.scanResults,
          performance: session.performance,
          trades:      session.trades ?? [],
          stats:       session.stats  ?? null,
        });
      },
    }),
    {
      name: 'backtest-v3',
      storage: createJSONStorage(() => ({
        getItem: (name: string) => { try { return localStorage.getItem(name); } catch { return null; } },
        setItem: (name: string, value: string) => {
          try { localStorage.setItem(name, value); }
          catch (e) {
            if (e instanceof DOMException && e.name === 'QuotaExceededError') {
              console.warn('[Backtest] Quota exceeded, clearing old sessions...');
              try { localStorage.removeItem('backtest-v2'); localStorage.removeItem('backtest-v1'); localStorage.setItem(name, value); } catch {}
            }
          }
        },
        removeItem: (name: string) => { try { localStorage.removeItem(name); } catch {} },
      })),
      partialize: (s) => ({
        market: s.market, scanDate: s.scanDate,
        strategy: s.strategy,
        // Compact sessions: keep only last 5, strip heavy forwardCandles
        sessions: s.sessions.slice(0, 5).map(sess => ({
          ...sess,
          scanResults: sess.scanResults.slice(0, 20),  // top 20 only
          performance: sess.performance.map(p => ({
            ...p,
            forwardCandles: p.forwardCandles.slice(0, 5),  // only 5 candles
          })).slice(0, 20),
        })),
        useCapitalMode: s.useCapitalMode,
        capitalConstraints: s.capitalConstraints,
        walkForwardConfig: s.walkForwardConfig,
      }),
    }
  )
);
