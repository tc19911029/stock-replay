import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  MarketId, StockScanResult, StockForwardPerformance, BacktestSession,
  ForwardCandle, sanitizeScanResult,
  ScanDiagnostics, createEmptyDiagnostics, mergeDiagnostics, diagnosticsSummary,
} from '@/lib/scanner/types';
import { TrendState } from '@/lib/analysis/trendAnalysis';
import { getMissingTradingDays } from '@/lib/utils/tradingDay';
import { applyPanelFilter } from '@/lib/selection/applyPanelFilter';
// Inline calcBacktestSummary to avoid pulling server-only ForwardAnalyzer → LocalCandleStore (fs)
function calcBacktestSummary(
  perf: StockForwardPerformance[],
  horizon: 'open' | 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd6' | 'd7' | 'd8' | 'd9' | 'd10' | 'd20',
) {
  const key = (horizon === 'open' ? 'openReturn' : `${horizon}Return`) as keyof StockForwardPerformance;
  const returns = perf
    .map(p => p[key] as number | null)
    .filter((r): r is number => r !== null);
  if (returns.length === 0) return null;
  const wins    = returns.filter(r => r > 0).length;
  const avg     = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sorted  = [...returns].sort((a, b) => a - b);
  const median  = sorted[Math.floor(sorted.length / 2)];
  const maxGain = Math.max(...returns);
  const maxLoss = Math.min(...returns);
  return {
    count:    returns.length,
    wins,
    losses:   returns.length - wins,
    winRate:  +(wins / returns.length * 100).toFixed(1),
    avgReturn: +avg.toFixed(2),
    median:   +median.toFixed(2),
    maxGain:  +maxGain.toFixed(2),
    maxLoss:  +maxLoss.toFixed(2),
  };
}
import {
  BacktestTrade, BacktestStats, BacktestStrategyParams,
  DEFAULT_STRATEGY, runBatchBacktest, runBatchBacktestWithCapital, calcBacktestStats,
  CapitalConstraints, DEFAULT_CAPITAL,
} from '@/lib/backtest/BacktestEngine';
import {
  WalkForwardResult, WalkForwardSession, runWalkForward as _runWalkForward,
} from '@/lib/backtest/WalkForwardTest';
import { useSettingsStore } from './settingsStore';

// Module-level abort controller for scan operations
let scanAbortController: AbortController | null = null;

// ── Types ──────────────────────────────────────────────────────────────────────

export type BacktestHorizon = 'open' | 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd6' | 'd7' | 'd8' | 'd9' | 'd10' | 'd20';

export interface BacktestSummary {
  count: number; wins: number; losses: number;
  winRate: number; avgReturn: number;
  median: number; maxGain: number; maxLoss: number;
}

/** Summary of a cron-saved scan date (no backtest data) */
export interface CronDateEntry {
  market: MarketId;
  date: string;
  resultCount: number;
  scanTime: string;
}

/** In-memory cache entry for preloaded scan results */
interface ScanCacheEntry {
  scanResults: StockScanResult[];
  performance: StockForwardPerformance[];
  marketTrend: TrendState | null;
}

/** Narrow scanDirection for APIs that only accept 'long' | 'short' */
function effectiveDirection(dir: 'long' | 'short' | 'daban'): 'long' | 'short' {
  return dir === 'daban' ? 'long' : dir;
}

/** Build cache key for scan results */
function scanCacheKey(market: MarketId, direction: string, mtf: boolean, date: string): string {
  return `${market}-${direction}-${mtf ? 'mtf' : 'daily'}-${date}`;
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
  useMultiTimeframe:   boolean;  // 長線保護短線開關
  capitalConstraints:  CapitalConstraints;

  // ── 掃描階段 ──
  isScanning:    boolean;
  scanProgress:  number;
  scanningStock: string;       // 目前正在掃描的股票名稱
  scanningCount: string;       // 進度文字，如 "123/600"
  scanError:     string | null;
  scanResults:   StockScanResult[];
  marketTrend:   TrendState | null;   // 大盤趨勢（掃描時取得）
  /** 掃描 session 的數據新鮮度摘要（從 ScanSession.dataFreshness 取得） */
  sessionDataFreshness: { avgStaleDays: number; maxStaleDays: number; staleCount: number; totalScanned: number; coverageRate: number; dataStatus: string } | null;
  scanTiming:    { listMs: number; ingestMs: number; chunkMs: number; forwardMs: number; totalMs: number } | null;

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
  /** 掃描模式：full=完整管線, pure=純朱家泓(14規則), sop=V2簡化版(六條件+戒律+淘汰法) */
  scanMode: 'full' | 'pure' | 'sop';
  /** 掃描方向：long=做多, short=做空, daban=打板 */
  scanDirection: 'long' | 'short' | 'daban';
  /** 當前買法（並列買法架構，Phase 6，2026-04-20）— 只在 scanDirection='long' 時有意義 */
  activeBuyMethod: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  /** 載入買法結果的狀態 */
  isLoadingBuyMethod: boolean;

  // ── Cron 歷史 ──
  cronDates: CronDateEntry[];
  isFetchingCron: boolean;
  isLoadingCronSession: boolean;

  // ── 快取：同日多條件版本切換 ──
  scanCache: Map<string, ScanCacheEntry>;

  // ── Actions ──
  setMarket:              (m: MarketId) => void;
  setScanDate:            (d: string)   => void;
  setStrategy:            (s: Partial<BacktestStrategyParams>) => void;
  setCapitalConstraints:  (c: Partial<CapitalConstraints>) => void;
  toggleCapitalMode:      () => void;
  toggleMultiTimeframe:   () => void;
  setScanOnly:            (v: boolean) => void;
  setScanMode:            (m: 'full' | 'pure' | 'sop') => void;
  setScanDirection:       (d: 'long' | 'short' | 'daban') => void;
  setActiveBuyMethod:     (m: 'A' | 'B' | 'C' | 'D' | 'E' | 'F') => Promise<void>;
  setWalkForwardConfig:   (c: Partial<WalkForwardConfig>) => void;
  computeWalkForward:     () => void;
  runScan:                () => Promise<void>;  // 統一入口（掃描+回測）
  cancelScan:             () => void;          // 取消進行中的掃描
  runAiRank:              () => Promise<void>;  // AI 排名
  loadSession:            (id: string)  => void;
  clearCurrent:           () => void;
  fetchCronDates:         (market: MarketId, direction?: 'long' | 'short') => Promise<void>;
  loadCronSession:        (market: MarketId, date: string, opts?: { scanOnly?: boolean; direction?: 'long' | 'short'; forceRefresh?: boolean }) => Promise<void>;
  autoLoadLatest:         () => Promise<void>;
  backfillHistory:        (market: MarketId, days?: number) => Promise<void>;

  // ── Backfill ──
  isBackfilling: boolean;
  backfillProgress: { done: number; total: number };

  // ── 掃描預設 ──
  scanPresets: ScanPreset[];
  saveScanPreset:  (name: string) => void;
  loadScanPreset:  (id: string) => void;
  deleteScanPreset: (id: string) => void;

  // helpers
  getSummary: (horizon: BacktestHorizon) => BacktestSummary | null;
}

export interface ScanPreset {
  id: string;
  name: string;
  market: MarketId;
  scanMode: 'full' | 'pure' | 'sop';
  scanDirection: 'long' | 'short' | 'daban';
  useCapitalMode: boolean;
  capitalConstraints: CapitalConstraints;
  strategy: BacktestStrategyParams;
  createdAt: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function today(): string {
  // Use TW timezone (UTC+8) consistently so scanDate matches what the user sees on screen
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
  }).format(new Date());
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useBacktestStore = create<BacktestState>()(
  persist(
    (set, get) => ({
      market:             'TW',
      scanDate:           today(),
      strategy:           DEFAULT_STRATEGY,
      useCapitalMode:     false,
      useMultiTimeframe:  false,
      capitalConstraints: DEFAULT_CAPITAL,
      walkForwardConfig:  { trainSize: 3, testSize: 1, stepSize: 1 },
      walkForwardResult:  null,
      isRunningWF:        false,

      isScanning:   false,
      scanProgress: 0,
      scanningStock: '',
      scanningCount: '',
      scanError:    null,
      scanResults:  [],
      marketTrend:  null,
      scanTiming:   null,
      sessionDataFreshness: null,

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
      scanMode: 'full' as const,
      scanDirection: 'long' as const,
      activeBuyMethod: 'A' as const,
      isLoadingBuyMethod: false,
      cronDates: [],
      isFetchingCron: false,
      isLoadingCronSession: false,
      scanCache: new Map(),
      isBackfilling: false,
      backfillProgress: { done: 0, total: 0 },
      scanPresets: [],

      saveScanPreset: (name) => {
        const { market, scanMode, scanDirection, useCapitalMode, capitalConstraints, strategy, scanPresets } = get();
        const preset: ScanPreset = {
          id: `preset-${Date.now()}`,
          name,
          market, scanMode, scanDirection, useCapitalMode, capitalConstraints, strategy,
          createdAt: new Date().toISOString(),
        };
        set({ scanPresets: [...scanPresets, preset] });
      },
      loadScanPreset: (id) => {
        const preset = get().scanPresets.find(p => p.id === id);
        if (!preset) return;
        set({
          market: preset.market,
          scanMode: preset.scanMode,
          scanDirection: preset.scanDirection,
          useCapitalMode: preset.useCapitalMode,
          capitalConstraints: preset.capitalConstraints,
          strategy: preset.strategy,
        });
      },
      deleteScanPreset: (id) => {
        set(s => ({ scanPresets: s.scanPresets.filter(p => p.id !== id) }));
      },

      setMarket: (market) => {
        // P3C: 切換市場時清除 MTF unfiltered 快取，防止跨市場 cache 污染
        // 例：在 CN 載入 5 檔後切換到 TW，再 toggle MTF 會還原 CN 結果
        const { scanCache } = get();
        for (const key of scanCache.keys()) {
          if (key.startsWith('_unfilteredResults')) {
            scanCache.delete(key);
          }
        }
        // 切換市場時若在打板模式，重設為多（打板僅限 CN）
        const { scanDirection } = get();
        const nextDir = scanDirection === 'daban' ? 'long' : scanDirection;
        set({ market, ...(nextDir !== scanDirection ? { scanDirection: nextDir } : {}) });
      },
      setScanDate: (scanDate) => {
        // P3C: 切換日期時清除所有 MTF unfiltered 快取（含 date-specific keys），
        // 避免 toggle 時還原舊日期結果
        const { scanCache } = get();
        for (const key of scanCache.keys()) {
          if (key.startsWith('_unfilteredResults')) {
            scanCache.delete(key);
          }
        }
        set({ scanDate, useMultiTimeframe: false });
      },
      setScanOnly:           (scanOnly) => set({ scanOnly }),
      setScanMode:           (scanMode) => set({ scanMode }),
      setScanDirection:      (scanDirection) => set({ scanDirection }),
      setActiveBuyMethod:    async (activeBuyMethod) => {
        const { market, scanDate, loadCronSession, scanDirection } = get();
        set({ activeBuyMethod });
        // A = 既有六條件流程，走 loadCronSession；同時刷新 daily 日期列表
        if (activeBuyMethod === 'A') {
          get().fetchCronDates(market, 'long'); // 切回 A 時刷新為 daily session 日期
          if (scanDirection === 'long' && scanDate) {
            await loadCronSession(market, scanDate, { scanOnly: true, direction: 'long' });
          }
          return;
        }
        // B/C/D/E：刷新對應買法的日期列表，再載入最新一天資料
        await get().fetchCronDates(market, 'long');
        // 若已有 scanDate 直接用，否則從 cronDates 選最新有結果的日期
        const targetDate = scanDate ?? (() => {
          const dates = get().cronDates.filter(c => c.market === market);
          return (dates.find(c => c.resultCount > 0) ?? dates[0])?.date ?? null;
        })();
        if (!targetDate) return;
        // 委託 loadCronSession（會補填 forward performance）
        await loadCronSession(market, targetDate, { scanOnly: true, direction: 'long' });
      },
      setStrategy:           (partial)  => set(s => ({ strategy: { ...s.strategy, ...partial } })),
      setCapitalConstraints: (partial)  => set(s => ({ capitalConstraints: { ...s.capitalConstraints, ...partial } })),
      toggleCapitalMode:     ()         => set(s => ({ useCapitalMode: !s.useCapitalMode })),
      toggleMultiTimeframe: () => {
        const { useMultiTimeframe, scanResults, performance, marketTrend, scanCache, scanDate } = get();
        const newMtf = !useMultiTimeframe;
        // P3C: 使用日期限定 key，避免切換日期後還原到舊日期結果
        const cacheKey = `_unfilteredResults:${scanDate}`;

        if (newMtf) {
          // MTF ON → client-side 過濾當前結果（結果必為子集，不會跑出新股票）
          // 先存原始未過濾結果以便還原
          scanCache.set(cacheKey, { scanResults, performance, marketTrend });

          // 過濾：只保留 MTF 週線 + 月線都通過的股票
          // （scan 時已 ALWAYS 計算 mtfWeeklyPass/mtfMonthlyPass，即使 MTF flag=off）
          // null = MTF 未計算（舊 B/C/D/E session）→ 保留；false = 明確不通過 → 過濾
          const filtered = scanResults.filter(r =>
            r.mtfWeeklyPass == null || r.mtfWeeklyPass === true,
          );
          const filteredSymbols = new Set(filtered.map(r => r.symbol));
          const filteredPerf = performance.filter(p => filteredSymbols.has(p.symbol));

          set({
            useMultiTimeframe: true,
            scanResults: filtered,
            performance: filteredPerf,
          });
        } else {
          // MTF OFF → 還原原始未過濾結果
          const cached = scanCache.get(cacheKey);
          if (cached) {
            set({
              useMultiTimeframe: false,
              scanResults: cached.scanResults,
              performance: cached.performance,
              marketTrend: cached.marketTrend,
            });
          } else {
            set({ useMultiTimeframe: false });
          }
        }
      },
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
              s.performance.map(p => [p.symbol, p.forwardCandles ?? []]),
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

      cancelScan: () => {
        if (scanAbortController) {
          scanAbortController.abort();
          scanAbortController = null;
        }
        set({ isScanning: false, isFetchingForward: false, scanProgress: 0, scanningStock: '', scanningCount: '', scanError: '已取消掃描' });
      },

      // ── 統一掃描入口（掃描 + 可選回測） ──
      runScan: async () => {
        // Cancel any in-flight scan
        if (scanAbortController) scanAbortController.abort();
        scanAbortController = new AbortController();
        const signal = scanAbortController.signal;

        const { market, scanDate, strategy, useCapitalMode, useMultiTimeframe, capitalConstraints, scanOnly } = get();

        // ── 歷史日期禁止 LIVE 掃描 ─────────────────────────────────────────
        // 收盤後的 L4 結果是定數，不該被前端按鈕覆蓋
        const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
        const isHistorical = scanDate < todayStr;
        if (isHistorical) {
          const dir = get().scanDirection;
          return get().loadCronSession(market, scanDate, {
            scanOnly: true,
            direction: dir === 'long' || dir === 'short' ? dir : 'long',
            forceRefresh: true,
          });
        }

        // ── Timing ──────────────────────────────────────────────────────────
        const t0 = globalThis.performance.now();
        let tList = t0, tIngest = t0, tChunk = t0;

        // ── Phase 1: Get stock list ──────────────────────────────────────────
        set({ isScanning: true, scanProgress: 5, scanningStock: '取得股票清單...', scanningCount: '', scanError: null,
              scanResults: [], performance: [], trades: [], stats: null, scanTiming: null });

        let stocks: Array<{ symbol: string; name: string }>;
        try {
          const listRes = await fetch(`/api/scanner/list?market=${market}`, { signal });
          if (!listRes.ok) throw new Error('無法取得股票清單');
          const listJson = await listRes.json() as { stocks: Array<{ symbol: string; name: string }> };
          stocks = listJson.stocks ?? [];
          tList = globalThis.performance.now();
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          set({ isScanning: false, scanError: String(e) });
          return;
        }

        // Skip ingest pre-check — scan uses LocalCandleStore internally, no extra round-trip needed
        set({ scanProgress: 10, scanningStock: `粗掃中...`, scanningCount: '' });

        // ── Phase 1.5: 盤中粗掃前置（只對今日掃描 + 交易時段生效） ──
        // 盤後/週末/假日：skip 粗掃（快照可能過期，chunk route 會自動降級為歷史掃描）
        const todayStrPre = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
        const isHistoricalPre = scanDate < todayStrPre;
        const dayOfWeek = new Date().getDay(); // 0=Sun, 6=Sat
        const isWeekendPre = dayOfWeek === 0 || dayOfWeek === 6;
        if (!isHistoricalPre && !isWeekendPre && get().scanDirection !== 'daban') {
          try {
            const coarseRes = await fetch('/api/scanner/coarse', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                market,
                direction: effectiveDirection(get().scanDirection),
              }),
              signal,
            });
            if (coarseRes.ok) {
              const coarseJson = await coarseRes.json();
              const candidates = coarseJson?.data?.candidates;
              if (Array.isArray(candidates) && candidates.length > 0) {
                stocks = candidates;
                set({ scanProgress: 15, scanningStock: `粗掃完成（${candidates.length} 檔候選）`, scanningCount: `${candidates.length}/${candidates.length}` });
              }
            }
          } catch {
            // 粗掃失敗，走全量掃描
          }
        }

        set({ scanProgress: 15, scanningStock: `分析中（${stocks.length} 檔）...`, scanningCount: `0/${stocks.length}` });

        // ── Phase 2: Split into 2 chunks, scan ──────────────────────────────
        const half   = Math.ceil(stocks.length / 2);
        const chunk1 = stocks.slice(0, half);
        const chunk2 = stocks.slice(half);

        // 使用與掃描器相同的 /api/scanner/chunk 端點 + 策略參數
        // 確保回測和掃描結果一致
        const activeStrategy = useSettingsStore.getState().getActiveStrategy();
        const strategyPayload = activeStrategy.isBuiltIn
          ? { strategyId: activeStrategy.id }
          : { thresholds: activeStrategy.thresholds };

        const { scanMode, scanDirection } = get();
        // 注意：歷史日期已在上方 return（走 loadCronSession），這裡只處理今日掃描

        const scanChunk = async (chunk: typeof stocks) => {
          const res = await fetch('/api/scanner/chunk', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              market,
              stocks: chunk,
              // 歷史日期已在上方走 loadCronSession，這裡只有今日掃描
              mode: scanMode,
              direction: effectiveDirection(scanDirection),
              multiTimeframeFilter: false,  // MTF 統一在前端過濾，後端永遠返回完整結果
              ...strategyPayload,
            }),
            signal,
          });
          if (!res.ok) throw new Error(`掃描失敗 (${res.status})`);
          const json = await res.json() as { results?: StockScanResult[]; marketTrend?: string; error?: string; diagnostics?: ScanDiagnostics };
          if (json.error) throw new Error(json.error);
          return {
            results: (json.results ?? []).map(sanitizeScanResult),
            marketTrend: json.marketTrend ?? null,
            diagnostics: json.diagnostics ?? createEmptyDiagnostics(),
          };
        };

        set({ scanProgress: 20, scanningStock: `分析中（${stocks.length} 檔）...`, scanningCount: `0/${stocks.length}` });

        // 並行掃描：掃描不再打 API（只讀本地資料），可以安全並行
        let results1: StockScanResult[] = [];
        let results2: StockScanResult[] = [];
        let mt: string | null = null;
        let diag1 = createEmptyDiagnostics();
        let diag2 = createEmptyDiagnostics();

        const scanPromise1 = scanChunk(chunk1).catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') throw e;
          return null;
        });
        const scanPromise2 = scanChunk(chunk2).catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') throw e;
          return null;
        });

        try {
          const [r1, r2] = await Promise.all([scanPromise1, scanPromise2]);
          if (r1) {
            results1 = r1.results;
            mt = r1.marketTrend;
            diag1 = r1.diagnostics;
          }
          if (r2) {
            results2 = r2.results;
            if (!mt) mt = r2.marketTrend;
            diag2 = r2.diagnostics;
          }
          tChunk = globalThis.performance.now();
          set({ scanProgress: 88, scanningCount: `${stocks.length} 檔候選` });
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
        }

        const combinedDiag = mergeDiagnostics(diag1, diag2);

        if (results1.length === 0 && results2.length === 0) {
          // 多態區分：Server Error / Data Unavailable / Partial / No Signal / Anomaly
          if (combinedDiag.totalStocks === 0 || combinedDiag.processedCount === 0) {
            // 兩個 chunk 都完全失敗（伺服器問題或 API 超時）
            set({ isScanning: false, scanError: '掃描服務暫時無法使用，請稍後再試' });
          } else if (combinedDiag.dataStatus === 'insufficient') {
            // 資料嚴重不足（覆蓋率 < 70%）
            set({ isScanning: false, scanError: `資料不足（覆蓋率 ${combinedDiag.coverageRate}%），請先執行盤後資料下載` });
          } else if (combinedDiag.dataStatus === 'partial') {
            // 部分覆蓋（70-95%），結果可能不完整
            set({ isScanning: false, scanError: `部分覆蓋 (${combinedDiag.coverageRate}%)，無符合條件的股票（${diagnosticsSummary(combinedDiag)}）` });
          } else if (combinedDiag.dataMissing > combinedDiag.totalStocks * 0.3) {
            // 超過 30% 股票缺資料 → 資料庫/Blob 問題
            set({ isScanning: false, scanError: `伺服器資料不足（${combinedDiag.dataMissing}/${combinedDiag.totalStocks} 檔缺資料），請等待每日排程完成` });
          } else if (combinedDiag.filteredOut > 0 && combinedDiag.dataMissing === 0) {
            // 正常：資料完整，有股票被處理但全被六條件過濾掉了
            set({ isScanning: false, scanError: `掃描完成，無符合條件的股票（${diagnosticsSummary(combinedDiag)}）` });
          } else {
            // 真正的異常：少量資料缺失或其他未預期錯誤
            set({ isScanning: false, scanError: `掃描異常（${diagnosticsSummary(combinedDiag)}）` });
          }
          return;
        }

        const combined: StockScanResult[] = [
          ...results1,
          ...results2,
        ].sort((a, b) =>
          b.sixConditionsScore !== a.sixConditionsScore
            ? b.sixConditionsScore - a.sixConditionsScore
            : b.changePercent - a.changePercent
        );
        const marketTrend = mt ? (mt as unknown as TrendState) : null;

        const tScanDone = globalThis.performance.now();
        set({ scanResults: combined, isScanning: false, scanProgress: 100, scanningStock: '', scanningCount: `${combined.length} 檔符合`, marketTrend });

        // MTF ON → 前端過濾（後端已永遠返回完整結果）
        if (useMultiTimeframe && combined.length > 0) {
          const cacheKey = `_unfilteredResults:${scanDate}`;
          get().scanCache.set(cacheKey, { scanResults: combined, performance: [], marketTrend });
          const filtered = combined.filter(r =>
            r.mtfWeeklyPass === true,
          );
          set({ scanResults: filtered, scanningCount: `${filtered.length} 檔符合（MTF）` });
        }

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
          const fwdJson = await fwdRes.json() as { performance?: StockForwardPerformance[]; nullCount?: number; totalRequested?: number };
          const fwdPerf = fwdJson.performance ?? [];

          // ── 掃描模式：只取前瞻表現，不做回測引擎 ──
          if (scanOnly) {
            const tEnd = globalThis.performance.now();
            set({
              performance: fwdPerf,
              isFetchingForward: false,
              scanTiming: {
                listMs:    Math.round(tList - t0),
                ingestMs:  Math.round(tIngest - tList),
                chunkMs:   Math.round(tChunk - tIngest),
                forwardMs: Math.round(tEnd - tScanDone),
                totalMs:   Math.round(tEnd - t0),
              },
            });

            // 背景存檔：永遠存完整結果（非 MTF 過濾版），確保 L4 數據完整
            const { scanDirection: dir } = get();
            // 如果有 unfiltered cache（MTF ON 時），用完整版存檔
            const unfilteredCache = get().scanCache.get(`_unfilteredResults:${scanDate}`);
            const saveResults = unfilteredCache?.scanResults ?? get().scanResults;
            // 資料品質守門：若全部結果都落後（L2 注入失敗），不覆蓋 L4 好數據
            const avgStaleDays = saveResults.length > 0
              ? saveResults.reduce((s, r) => s + ((r as { dataFreshness?: { daysStale?: number } }).dataFreshness?.daysStale ?? 0), 0) / saveResults.length
              : 0;
            if (avgStaleDays >= 1) {
              console.warn(`[runScan] 掃描結果落後 ${avgStaleDays.toFixed(1)} 天，不存入 L4 以保護已有的好數據`);
              return;
            }
            fetch('/api/scanner/save-session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                market, date: scanDate, direction: effectiveDirection(dir),
                multiTimeframeEnabled: false,  // 永遠存完整版
                results: saveResults,
                scanTime: new Date().toISOString(),
              }),
            }).then(() => {
              // 存檔成功後更新日期列表
              get().fetchCronDates(market, effectiveDirection(dir));
            }).catch(() => { /* non-fatal */ });

            return;
          }

          // ── Phase 4: Run strict BacktestEngine ────────────────────────────
          // Build forward candles map: symbol → ForwardCandle[]
          const candlesMap: Record<string, ForwardCandle[]> = {};
          for (const p of fwdPerf) {
            if (p.forwardCandles) candlesMap[p.symbol] = p.forwardCandles;
          }

          let trades: BacktestTrade[];
          let skippedCount: number;
          let skippedByCapital = 0;
          let finalCapital: number | null = null;
          let capitalReturn: number | null = null;
          let skipReasons: import('@/lib/backtest/BacktestEngine').SkipReasons | undefined;

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
            skipReasons  = result.skipReasons;
          }

          const stats = calcBacktestStats(trades, skippedCount, skipReasons);

          // ── Save session ──────────────────────────────────────────────────
          const session: BacktestSession = {
            id:          `${market}-${scanDate}-${Date.now()}`,
            market,
            scanDate,
            createdAt:   new Date().toISOString(),
            scanResults: combined,
            performance: fwdPerf,
            trades,
            stats:       stats ?? undefined,
            strategyVersion: `holdDays=${strategy.holdDays},sl=${strategy.stopLoss ?? 'off'},tp=${strategy.takeProfit ?? 'off'},ma5=${strategy.ma5StopLoss ? 'on' : 'off'}`,
          };

          const tEnd = globalThis.performance.now();
          set(s => ({
            performance: fwdPerf,
            trades,
            stats,
            skippedByCapital,
            finalCapital,
            capitalReturn,
            isFetchingForward: false,
            sessions: [session, ...s.sessions].slice(0, 20),
            scanTiming: {
              listMs:    Math.round(tList - t0),
              ingestMs:  Math.round(tIngest - tList),
              chunkMs:   Math.round(tChunk - tIngest),
              forwardMs: Math.round(tEnd - tScanDone),
              totalMs:   Math.round(tEnd - t0),
            },
          }));
        } catch (e) {
          set({ isFetchingForward: false, forwardError: String(e) });
        }
      },

      loadSession: (id) => {
        const session = get().sessions.find(s => s.id === id);
        if (!session) return;
        const hasTrades = (session.trades?.length ?? 0) > 0;
        set({
          market:      session.market,
          scanDate:    session.scanDate,
          scanResults: session.scanResults,
          performance: session.performance,
          trades:      session.trades ?? [],
          stats:       session.stats  ?? null,
          scanOnly:    !hasTrades,
        });
      },

      // ── 補齊歷史：掃描過去 N 個交易日並存檔 ──
      backfillHistory: async (market, days = 20) => {
        const existingDates = new Set(get().cronDates.filter(c => c.market === market).map(c => c.date));

        // 計算過去 N 個交易日（周一到周五）
        const tradingDays: string[] = [];
        const cursor = new Date();
        cursor.setDate(cursor.getDate() - 1); // 從昨天開始（今天 cron 會跑）
        while (tradingDays.length < days) {
          const day = cursor.getDay();
          if (day !== 0 && day !== 6) {
            const dateStr = cursor.toISOString().split('T')[0];
            if (!existingDates.has(dateStr)) tradingDays.push(dateStr);
          }
          cursor.setDate(cursor.getDate() - 1);
        }

        if (tradingDays.length === 0) return;

        set({ isBackfilling: true, backfillProgress: { done: 0, total: tradingDays.length } });

        for (let i = 0; i < tradingDays.length; i++) {
          const date = tradingDays[i];
          try {
            const res = await fetch('/api/scanner/backfill', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ market, date, direction: get().scanDirection }),
            });
            if (res.ok) {
              const json = await res.json() as { count?: number; skipped?: boolean };
              if (!json.skipped) {
                // 新增到 cronDates
                set(s => ({
                  cronDates: [
                    { market, date, resultCount: json.count ?? -1, scanTime: new Date().toISOString() },
                    ...s.cronDates.filter(c => !(c.market === market && c.date === date)),
                  ].sort((a, b) => b.date.localeCompare(a.date)),
                }));
              }
            }
          } catch { /* 單筆失敗不中斷整體 */ }
          set({ backfillProgress: { done: i + 1, total: tradingDays.length } });
        }

        set({ isBackfilling: false });
      },

      // ── Cron 歷史：取得所有可用日期 ──
      fetchCronDates: async (market, direction) => {
        const dir = direction ?? get().scanDirection;
        const { activeBuyMethod } = get();
        // B/C/D/E 讀對應買法 session 清單；A 讀 daily（MTF 在前端過濾）
        const mtfParam = (activeBuyMethod && activeBuyMethod !== 'A') ? activeBuyMethod : 'daily';
        set({ isFetchingCron: true });
        try {
          const res = await fetch(`/api/scanner/results?market=${market}&direction=${dir}&mtf=${mtfParam}`);
          if (!res.ok) throw new Error('fetch failed');
          const json = await res.json() as { sessions?: Array<{ date: string; resultCount: number; scanTime: string }> };
          const entries: CronDateEntry[] = (json.sessions ?? []).map(s => ({
            market,
            date: s.date,
            resultCount: s.resultCount,
            scanTime: s.scanTime,
          }));
          // Merge by market: keep other markets' entries, replace this market's entries
          // This prevents race conditions where TW fetch overwrites CN entries
          set(state => ({
            cronDates: [
              ...state.cronDates.filter(c => c.market !== market),
              ...entries,
            ],
            isFetchingCron: false,
          }));
        } catch {
          set({ isFetchingCron: false });
        }
      },

      // ── Cron 歷史：載入特定日期的掃描結果 ──
      // opts.scanOnly = true → 只載入掃描結果 + 前向績效，不跑回測引擎
      loadCronSession: async (market, date, opts) => {
        const { strategy, useCapitalMode, capitalConstraints, scanDirection, useMultiTimeframe, scanCache, activeBuyMethod } = get();
        const direction = opts?.direction ?? scanDirection;
        const onlyScan = opts?.scanOnly ?? false;

        // B/C/D/E：直接載入對應買法 session，不走 A 的流程
        if (activeBuyMethod && activeBuyMethod !== 'A') {
          set({ isLoadingBuyMethod: true, scanResults: [], performance: [], scanError: null, market, scanDate: date });
          try {
            const res = await fetch(`/api/scanner/results?market=${market}&date=${date}&direction=long&mtf=${activeBuyMethod}`);
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error ?? '載入失敗');
            const session = (json as { sessions?: Array<{ results: StockScanResult[] }> })?.sessions?.[0];
            const scanResults = session?.results ?? [];
            set({ scanResults, isLoadingBuyMethod: false });

            // 補填 forward performance（同 A 路徑）
            if (scanResults.length > 0) {
              set({ isFetchingForward: true });
              const forwardPayload = scanResults.map(r => ({ symbol: r.symbol, name: r.name, scanPrice: r.price }));
              const fwdRes = await fetch('/api/backtest/forward', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scanDate: date, stocks: forwardPayload }),
              });
              if (fwdRes.ok) {
                const fwdJson = await fwdRes.json() as { performance?: StockForwardPerformance[] };
                set({ performance: fwdJson.performance ?? [] });
              }
              set({ isFetchingForward: false });
            }
          } catch (err) {
            set({ isLoadingBuyMethod: false, isFetchingForward: false, scanError: err instanceof Error ? err.message : '買法掃描失敗' });
          }
          return;
        }

        const mtfParam = 'daily';  // 永遠載入完整結果，MTF 在前端過濾
        // Normalize 'daban' → 'long' for API (API only accepts 'long'|'short')
        const apiDirection = effectiveDirection(direction);

        // Check cache first
        const cacheKey = scanCacheKey(market, direction, useMultiTimeframe, date);
        const cached = scanCache.get(cacheKey);
        if (cached && onlyScan && !opts?.forceRefresh) {
          // 快取命中：先顯示 scanResults（秒開）
          set({
            market, scanDate: date, scanOnly: true,
            scanResults: cached.scanResults,
            performance: cached.performance,
            marketTrend: cached.marketTrend,
            scanError: null, forwardError: null,
          });
          // 如果快取只有 scanResults 沒有 performance（預載快取），背景補填 forward
          if (cached.scanResults.length > 0 && cached.performance.length === 0) {
            (async () => {
              try {
                set({ isFetchingForward: true });
                const forwardPayload = cached.scanResults.map(r => ({
                  symbol: r.symbol, name: r.name, scanPrice: r.price,
                }));
                const fwdRes = await fetch('/api/backtest/forward', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ scanDate: date, stocks: forwardPayload }),
                });
                if (!fwdRes.ok) return;
                const fwdJson = await fwdRes.json() as { performance?: StockForwardPerformance[] };
                const performance = fwdJson.performance ?? [];
                // 更新快取和 UI（僅當用戶還在看這個日期時）
                if (get().scanDate === date) {
                  let displayPerf = performance;
                  if (useMultiTimeframe) {
                    const filteredSymbols = new Set(cached.scanResults.filter(r =>
                      r.mtfWeeklyPass === true,
                    ).map(r => r.symbol));
                    displayPerf = performance.filter(p => filteredSymbols.has(p.symbol));
                  }
                  scanCache.set(cacheKey, { scanResults: cached.scanResults, performance: displayPerf, marketTrend: cached.marketTrend });
                  set({ performance: displayPerf, isFetchingForward: false });
                }
              } catch { /* forward 失敗不影響已顯示的 scanResults */ }
              finally { set({ isFetchingForward: false }); }
            })();
          }
          return;
        }

        // P3C: 載入新日期時清除 MTF 快取，確保 toggle 基於新日期結果
        scanCache.delete('_unfilteredResults');
        scanCache.delete(`_unfilteredResults:${date}`);

        set({
          isLoadingCronSession: true,
          scanResults: [], performance: [], trades: [], stats: null,
          scanError: null, forwardError: null, marketTrend: null,
          market, scanDate: date, scanOnly: true,
        });

        try {
          // Phase 1: Load scan results from server (with MTF dimension)
          const res = await fetch(`/api/scanner/results?market=${market}&date=${date}&direction=${apiDirection}&mtf=${mtfParam}`);
          if (!res.ok) throw new Error('無法載入歷史掃描結果');
          const json = await res.json() as { sessions?: Array<{ results: StockScanResult[]; marketTrend?: string; dataFreshness?: { avgStaleDays: number; maxStaleDays: number; staleCount: number; totalScanned: number; coverageRate: number; dataStatus: string } }> };
          const session0 = json.sessions?.[0];
          const scanResults = session0?.results ?? [];
          if (scanResults.length === 0) {
            set({ isLoadingCronSession: false });
            return;
          }
          const sessionMarketTrend = session0?.marketTrend ?? null;

          // MTF ON → 前端過濾（API 永遠返回完整結果）
          let displayResults = scanResults;
          if (useMultiTimeframe) {
            const cacheKey = `_unfilteredResults:${date}`;
            scanCache.set(cacheKey, { scanResults, performance: [], marketTrend: sessionMarketTrend as TrendState | null });
            displayResults = scanResults.filter(r =>
              r.mtfWeeklyPass === true,
            );
          }

          set({
            scanResults: displayResults,
            sessionDataFreshness: session0?.dataFreshness ?? null,
            marketTrend: sessionMarketTrend as TrendState | null,
          });

          // Phase 2: Fetch forward performance
          set({ isFetchingForward: true });
          const forwardPayload = scanResults.map(r => ({
            symbol: r.symbol, name: r.name, scanPrice: r.price,
          }));
          const fwdRes = await fetch('/api/backtest/forward', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scanDate: date, stocks: forwardPayload }),
          });
          if (!fwdRes.ok) throw new Error('無法取得後續績效資料');
          const fwdJson = await fwdRes.json() as { performance?: StockForwardPerformance[] };
          const performance = fwdJson.performance ?? [];

          // scanOnly mode: skip backtest engine, just show scan results + forward perf
          if (onlyScan) {
            // MTF ON → 過濾 performance（只顯示 MTF 通過的股票）
            let displayPerf = performance;
            if (useMultiTimeframe) {
              const filteredSymbols = new Set(displayResults.map(r => r.symbol));
              displayPerf = performance.filter(p => filteredSymbols.has(p.symbol));
              // 更新 unfiltered cache 含完整 performance
              const unfilteredKey = `_unfilteredResults:${date}`;
              const cached = scanCache.get(unfilteredKey);
              if (cached) {
                scanCache.set(unfilteredKey, { ...cached, performance });
              }
            }
            // Save to cache for instant switching later
            const { scanResults: currentResults, scanCache: cache, marketTrend: currentMarketTrend } = get();
            cache.set(cacheKey, { scanResults: currentResults, performance: displayPerf, marketTrend: currentMarketTrend });
            set({
              performance: displayPerf,
              isFetchingForward: false,
              isLoadingCronSession: false,
            });
            return;
          }

          // Phase 3: Run backtest engine
          const candlesMap: Record<string, ForwardCandle[]> = {};
          for (const p of performance) {
            if (p.forwardCandles) candlesMap[p.symbol] = p.forwardCandles;
          }

          let trades: BacktestTrade[];
          let skippedCount: number;
          let skippedByCapital = 0;
          let finalCapital: number | null = null;
          let capitalReturn: number | null = null;
          let skipReasonsInc: import('@/lib/backtest/BacktestEngine').SkipReasons | undefined;

          if (useCapitalMode) {
            const result = runBatchBacktestWithCapital(scanResults, candlesMap, strategy, capitalConstraints);
            trades = result.trades;
            skippedCount = result.skippedCount;
            skippedByCapital = result.skippedByCapital;
            finalCapital = result.finalCapital;
            capitalReturn = result.capitalReturn;
          } else {
            const result = runBatchBacktest(scanResults, candlesMap, strategy);
            trades = result.trades;
            skippedCount = result.skippedCount;
            skipReasonsInc = result.skipReasons;
          }

          const stats = calcBacktestStats(trades, skippedCount, skipReasonsInc);

          // Save as session
          const session: BacktestSession = {
            id: `${market}-${date}-${Date.now()}`,
            market,
            scanDate: date,
            createdAt: new Date().toISOString(),
            scanResults,
            performance,
            trades,
            stats: stats ?? undefined,
            strategyVersion: `holdDays=${strategy.holdDays},sl=${strategy.stopLoss ?? 'off'},tp=${strategy.takeProfit ?? 'off'},ma5=${strategy.ma5StopLoss ? 'on' : 'off'}`,
          };

          set(s => ({
            performance,
            trades,
            stats,
            skippedByCapital,
            finalCapital,
            capitalReturn,
            isFetchingForward: false,
            isLoadingCronSession: false,
            sessions: [session, ...s.sessions].slice(0, 20),
            cronDates: s.cronDates.filter(c => !(c.market === market && c.date === date)),
          }));
        } catch (e) {
          set({ isFetchingForward: false, isLoadingCronSession: false, forwardError: String(e) });
        }
      },

      // ── 自動載入最新掃描結果（含自動補齊缺漏交易日）──
      autoLoadLatest: async () => {
        const { market, scanDirection, scanResults, isScanning, isFetchingForward, isLoadingCronSession } = get();
        // 如果已有結果或正在載入中，不重複載入
        if (scanResults.length > 0 || isScanning || isFetchingForward || isLoadingCronSession) return;

        // 打板模式由 ScanPanel useEffect 負責載入日期，不走 autoLoadLatest
        if (scanDirection === 'daban') return;

        const dir = effectiveDirection(scanDirection);

        // 1. 先取得可用日期（快速，只列檔案）
        await get().fetchCronDates(market, dir);
        const { cronDates } = get();

        // 2. 如果已有日期 → 優先載入最近有結果（resultCount > 0）的一天，
        //    若全為 0 或未知則退回最新日期（不等 backfill）
        const marketDates = cronDates.filter(c => c.market === market);
        if (marketDates.length > 0) {
          const bestDate =
            marketDates.find(c => c.resultCount > 0)?.date ??
            marketDates[0].date;
          const latestDate = bestDate;
          await get().loadCronSession(market, latestDate, { scanOnly: true, direction: dir });

          // 3. 背景預載最近 5 天到 scanCache（不阻塞 UI）
          const datesToPreload = marketDates
            .map(c => c.date)
            .filter(d => d !== latestDate)
            .slice(0, 4); // 最新一天已載入，預載接下來 4 天
          if (datesToPreload.length > 0) {
            // fire-and-forget: 背景預載，不 await
            Promise.all(datesToPreload.map(async (date) => {
              // 預載永遠抓完整（unfiltered）結果，存在 mtf=false 的 key 下
              // MTF=on 時 key 不同 → cache miss → loadCronSession 重抓並正確過濾
              const cacheKey = scanCacheKey(market, scanDirection, false, date);
              if (get().scanCache.has(cacheKey)) return; // 已快取
              try {
                const res = await fetch(`/api/scanner/results?market=${market}&date=${date}&direction=${dir}&mtf=daily`);
                if (!res.ok) return;
                const json = await res.json() as { sessions?: Array<{ results: StockScanResult[]; marketTrend?: string }> };
                const session0 = json.sessions?.[0];
                const results = session0?.results ?? [];
                if (results.length > 0) {
                  get().scanCache.set(cacheKey, {
                    scanResults: results,
                    performance: [],
                    marketTrend: (session0?.marketTrend ?? null) as TrendState | null,
                  });
                }
              } catch { /* 預載失敗不影響 UI */ }
            })).catch(() => {});
          }
        }

        // 4. 背景補齊缺漏日期（不阻塞 UI）
        const existingDates = new Set(marketDates.map(c => c.date));
        const missingDays = getMissingTradingDays(existingDates, 5, market);
        if (missingDays.length > 0) {
          // fire-and-forget: 背景 backfill
          (async () => {
            set({ isBackfilling: true, backfillProgress: { done: 0, total: missingDays.length } });
            for (let i = 0; i < missingDays.length; i++) {
              try {
                await fetch('/api/scanner/backfill', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ market, date: missingDays[i], direction: dir }),
                });
              } catch { /* 單筆失敗不中斷 */ }
              set({ backfillProgress: { done: i + 1, total: missingDays.length } });
            }
            set({ isBackfilling: false });
            // 補完後刷新日期列表
            await get().fetchCronDates(market, dir);
          })().catch(() => {});
        }
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
            forwardCandles: (p.forwardCandles ?? []).slice(0, 5),  // only 5 candles
          })).slice(0, 20),
        })),
        useCapitalMode: s.useCapitalMode,
        capitalConstraints: s.capitalConstraints,
        walkForwardConfig: s.walkForwardConfig,
      }),
    }
  )
);
