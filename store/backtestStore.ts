import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  MarketId, StockScanResult, StockForwardPerformance, BacktestSession,
} from '@/lib/scanner/types';
import { TrendState } from '@/lib/analysis/trendAnalysis';
import { calcBacktestSummary } from '@/lib/backtest/ForwardAnalyzer';
import {
  BacktestTrade, BacktestStats, BacktestStrategyParams,
  DEFAULT_STRATEGY, runBatchBacktest, runBatchBacktestWithCapital, calcBacktestStats,
  CapitalConstraints, DEFAULT_CAPITAL,
} from '@/lib/backtest/BacktestEngine';
import {
  WalkForwardResult, WalkForwardSession, runWalkForward as _runWalkForward,
} from '@/lib/backtest/WalkForwardTest';
import { useSettingsStore } from './settingsStore';

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
  trainSize: number;
  testSize:  number;
  stepSize:  number;
}

/** 統一掃描+回測 Store（合併原 scannerStore + backtestStore） */
interface BacktestState {
  // ── 控制面板 ──
  market:              MarketId;
  scanDate:            string;
  strategy:            BacktestStrategyParams;
  useCapitalMode:      boolean;
  capitalConstraints:  CapitalConstraints;

  // ── 掃描階段 ──
  isScanning:    boolean;
  scanProgress:  number;
  scanError:     string | null;
  scanResults:   StockScanResult[];
  marketTrend:   TrendState | null;   // 大盤趨勢（掃描時取得）

  // ── 前瞻績效階段 ──
  isFetchingForward: boolean;
  forwardError:  string | null;
  performance:   StockForwardPerformance[];

  // ── 嚴謹回測階段 ──
  trades:           BacktestTrade[];
  stats:            BacktestStats | null;
  skippedByCapital: number;
  finalCapital:     number | null;
  capitalReturn:    number | null;

  // ── AI 排名 ──
  aiRanking: { isRanking: boolean; error: string | null };

  // ── 歷史記錄 ──
  sessions: BacktestSession[];

  // ── Walk-Forward ──
  walkForwardConfig:  WalkForwardConfig;
  walkForwardResult:  WalkForwardResult | null;
  isRunningWF:        boolean;

  // ── 模式 ──
  scanOnly: boolean;  // true = 只掃描不回測（今天的掃描）

  // ── Actions ──
  setMarket:              (m: MarketId) => void;
  setScanDate:            (d: string)   => void;
  setStrategy:            (s: Partial<BacktestStrategyParams>) => void;
  setCapitalConstraints:  (c: Partial<CapitalConstraints>) => void;
  toggleCapitalMode:      () => void;
  setScanOnly:            (v: boolean) => void;
  setWalkForwardConfig:   (c: Partial<WalkForwardConfig>) => void;
  computeWalkForward:     () => void;
  runScan:                () => Promise<void>;  // 統一入口（掃描+回測）
  runAiRank:              () => Promise<void>;  // AI 排名
  loadSession:            (id: string)  => void;
  clearCurrent:           () => void;

  // helpers
  getSummary: (horizon: BacktestHorizon) => BacktestSummary | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().split('T')[0];
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useBacktestStore = create<BacktestState>()(
  persist(
    (set, get) => ({
      market:             'TW',
      scanDate:           today(),
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
      marketTrend:  null,

      isFetchingForward: false,
      forwardError:  null,
      performance:   [],

      trades:           [],
      stats:            null,
      skippedByCapital: 0,
      finalCapital:     null,
      capitalReturn:    null,

      aiRanking: { isRanking: false, error: null },
      sessions: [],
      scanOnly: false,

      setMarket:             (market)   => set({ market }),
      setScanDate:           (scanDate) => set({ scanDate }),
      setScanOnly:           (scanOnly) => set({ scanOnly }),
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

      // ── AI 排名（從掃描器遷移） ──
      runAiRank: async () => {
        const { market, scanResults } = get();
        if (scanResults.length === 0) return;
        set({ aiRanking: { isRanking: true, error: null } });
        try {
          const top = scanResults
            .filter(r => r.sixConditionsScore >= 4)
            .slice(0, 15)
            .map(r => ({
              symbol: r.symbol, name: r.name, price: r.price,
              change: r.changePercent, score: r.sixConditionsScore,
              surgeScore: r.surgeScore, surgeGrade: r.surgeGrade,
              histWinRate: r.histWinRate,
            }));
          const res = await fetch('/api/scanner/ai-rank', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ market, stocks: top }),
          });
          if (!res.ok) throw new Error('AI 排名失敗');
          const json = await res.json();
          const rankings: Array<{ symbol: string; rank: number; confidence: number; reason: string }> = json.rankings ?? [];

          // Merge AI rankings into scanResults
          const rankMap = new Map(rankings.map(r => [r.symbol, r]));
          const updatedResults: StockScanResult[] = get().scanResults.map(r => {
            const ai = rankMap.get(r.symbol);
            if (!ai) return r;
            const conf = ai.confidence >= 80 ? 'high' : ai.confidence >= 50 ? 'medium' : 'low';
            return { ...r, aiRank: ai.rank, aiConfidence: conf as StockScanResult['aiConfidence'], aiReason: ai.reason };
          });
          set({ scanResults: updatedResults, aiRanking: { isRanking: false, error: null } });
        } catch (e) {
          set({ aiRanking: { isRanking: false, error: String(e) } });
        }
      },

      // ── 統一掃描入口（掃描 + 可選回測） ──
      runScan: async () => {
        const { market, scanDate, strategy, useCapitalMode, capitalConstraints, scanOnly } = get();

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

        // 使用與掃描器相同的 /api/scanner/chunk 端點 + 策略參數
        // 確保回測和掃描結果一致
        const activeStrategy = useSettingsStore.getState().getActiveStrategy();
        const strategyPayload = activeStrategy.isBuiltIn
          ? { strategyId: activeStrategy.id }
          : { thresholds: activeStrategy.thresholds };

        const scanChunk = async (chunk: typeof stocks) => {
          const res = await fetch('/api/scanner/chunk', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              market,
              stocks: chunk,
              date: scanDate,
              ...strategyPayload,
            }),
          });
          if (!res.ok) throw new Error(`掃描失敗 (${res.status})`);
          const json = await res.json() as { results?: StockScanResult[]; marketTrend?: string; error?: string };
          if (json.error) throw new Error(json.error);
          return { results: json.results ?? [], marketTrend: json.marketTrend ?? null };
        };

        set({ scanProgress: 30 });

        const [r1, r2] = await Promise.allSettled([scanChunk(chunk1), scanChunk(chunk2)]);

        if (r1.status === 'rejected' && r2.status === 'rejected') {
          set({ isScanning: false, scanError: `掃描失敗：${r1.reason}` });
          return;
        }

        const combined: StockScanResult[] = [
          ...(r1.status === 'fulfilled' ? r1.value.results : []),
          ...(r2.status === 'fulfilled' ? r2.value.results : []),
        ].sort((a, b) =>
          b.sixConditionsScore !== a.sixConditionsScore
            ? b.sixConditionsScore - a.sixConditionsScore
            : b.changePercent - a.changePercent
        );

        // 取得大盤趨勢（從第一個 chunk 的回應）
        const mt = r1.status === 'fulfilled' ? r1.value.marketTrend : null;
        const marketTrend = mt ? (mt as unknown as TrendState) : null;

        set({ scanResults: combined, isScanning: false, scanProgress: 100, marketTrend });

        if (combined.length === 0) return;

        // ── 台股：異步補充籌碼面資料 ──────────────────────────────────────
        if (market === 'TW') {
          let chipDate = scanDate;
          const cd = new Date(chipDate + 'T00:00:00');
          if (cd.getDay() === 0) chipDate = new Date(cd.getTime() - 2 * 86400000).toISOString().slice(0, 10);
          else if (cd.getDay() === 6) chipDate = new Date(cd.getTime() - 1 * 86400000).toISOString().slice(0, 10);
          fetch(`/api/chip?date=${chipDate}`)
            .then(r => r.json())
            .then((chipJson: { data?: Array<{ symbol: string; chipScore: number; chipGrade: string; chipSignal: string; chipDetail: string; foreignBuy: number; trustBuy: number; dealerBuy: number; marginNet: number; shortNet: number; marginBalance: number; shortBalance: number; dayTradeRatio: number; largeTraderNet: number }> }) => {
              if (!chipJson.data) return;
              const chipMap = new Map(chipJson.data.map(d => [d.symbol, d]));
              const current = get().scanResults;
              const enriched = current.map(r => {
                const sym = r.symbol.replace(/\.(TW|TWO)$/i, '');
                const chip = chipMap.get(sym);
                if (!chip) return r;
                return { ...r, chipScore: chip.chipScore, chipGrade: chip.chipGrade, chipSignal: chip.chipSignal, chipDetail: chip.chipDetail, foreignBuy: chip.foreignBuy, trustBuy: chip.trustBuy, dealerBuy: chip.dealerBuy, marginNet: chip.marginNet, shortNet: chip.shortNet, marginBalance: chip.marginBalance, shortBalance: chip.shortBalance, dayTradeRatio: chip.dayTradeRatio, largeTraderNet: chip.largeTraderNet };
              });
              set({ scanResults: enriched });
            })
            .catch(() => {});
        }

        // ── 掃描模式：到此為止，不做前瞻回測 ──
        if (scanOnly) return;

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
