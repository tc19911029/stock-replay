import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { StockScanResult, ScanSession, MarketId } from '@/lib/scanner/types';
import { TrendState } from '@/lib/analysis/trendAnalysis';
import { useSettingsStore } from './settingsStore';

const TW_STOCK_NAMES = [
  '台積電','聯發科','日月光投控','聯電','聯詠','瑞昱','矽力','華邦電','力積電','旺宏',
  '南亞科','京元電子','創意','力成','信驊','同欣電','環球晶','中美晶','鴻海','廣達',
  '台達電','緯穎','緯創','和碩','英業達','研華','臻鼎','光寶科','聯強','奇鋐',
];
const CN_STOCK_NAMES = [
  '貴州茅台','中國平安','招商銀行','工商銀行','長江電力','農業銀行','建設銀行',
  '中國銀行','紫金礦業','伊利股份','中國石化','恆瑞醫藥','五糧液','美的集團',
  '比亞迪','格力電器','平安銀行','中信證券','興業銀行','海康威視',
];

const MAX_HISTORY = 10;

// ── Safe localStorage wrapper (prevents QuotaExceededError) ──
const safeStorage = {
  getItem: (name: string) => {
    try { return localStorage.getItem(name); }
    catch { return null; }
  },
  setItem: (name: string, value: string) => {
    try {
      localStorage.setItem(name, value);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        console.warn('[Storage] Quota exceeded, clearing old data...');
        try {
          // Clear old scanner data to free space
          localStorage.removeItem('scanner-v3');
          localStorage.removeItem('scanner-v2');
          localStorage.removeItem('scanner-v1');
          localStorage.setItem(name, value);
        } catch { console.error('[Storage] Still full after cleanup'); }
      }
    }
  },
  removeItem: (name: string) => {
    try { localStorage.removeItem(name); } catch {}
  },
};

/** Strip heavy fields from scan results for storage (keep only top N) */
function compactResults(results: StockScanResult[], topN = 20): StockScanResult[] {
  return results
    .sort((a, b) => (b.surgeScore ?? 0) - (a.surgeScore ?? 0))
    .slice(0, topN)
    .map(r => ({
      ...r,
      surgeComponents: undefined as unknown as typeof r.surgeComponents,  // strip heavy nested data
      triggeredRules: r.triggeredRules?.slice(0, 3),  // keep only top 3 rules
    }));
}

/** Strip heavy fields from history sessions */
function compactHistory(sessions: ScanSession[]): ScanSession[] {
  return sessions.slice(0, MAX_HISTORY).map(s => ({
    ...s,
    results: compactResults(s.results, 10),  // only top 10 per session
  }));
}

// ── Per-market scan state ──────────────────────────────────────────────────────
interface MarketScanState {
  isScanning: boolean;
  progress: number;
  scanningStock: string;
  scanningIndex: number;
  scanningTotal: number;
  results: StockScanResult[];
  lastScanTime: string | null;
  marketTrend: TrendState | null;  // 大盤趨勢（掃描時取得）
  error: string | null;
  scanDate?: string;  // 掃描日期，空字串或 undefined 代表今天/最新
}

const DEFAULT_TW: MarketScanState = {
  isScanning: false, progress: 0, scanningStock: '', scanningIndex: 0,
  scanningTotal: 500, results: [], lastScanTime: null, marketTrend: null, error: null,
};
const DEFAULT_CN: MarketScanState = {
  isScanning: false, progress: 0, scanningStock: '', scanningIndex: 0,
  scanningTotal: 500, results: [], lastScanTime: null, marketTrend: null, error: null,
};

interface AiRankingState {
  isRanking: boolean;
  error: string | null;
}

interface ScannerStore {
  activeMarket: MarketId;
  tw: MarketScanState;
  cn: MarketScanState;
  twHistory: ScanSession[];
  cnHistory: ScanSession[];
  aiRanking: AiRankingState;

  setActiveMarket: (market: MarketId) => void;
  setScanDate: (market: MarketId, date: string) => void;
  runScan: (market: MarketId) => Promise<void>;
  runAiRank: (market: MarketId) => Promise<void>;
  getHistory: (market: MarketId) => ScanSession[];
  getMarket: (market: MarketId) => MarketScanState;
}

export const useScannerStore = create<ScannerStore>()(
  persist(
    (set, get) => ({
      activeMarket: 'TW',
      tw: DEFAULT_TW,
      cn: DEFAULT_CN,
      twHistory: [],
      cnHistory: [],
      aiRanking: { isRanking: false, error: null },

      setActiveMarket: (market) => set({ activeMarket: market }),
      setScanDate: (market, date) => {
        const mKey = market === 'TW' ? 'tw' : 'cn';
        set(s => ({ [mKey]: { ...s[mKey], scanDate: date } }));
      },
      getHistory: (market) => market === 'TW' ? get().twHistory : get().cnHistory,
      getMarket: (market) => market === 'TW' ? get().tw : get().cn,

      runScan: async (market) => {
        const mKey  = market === 'TW' ? 'tw' : 'cn';
        const names = market === 'TW' ? TW_STOCK_NAMES : CN_STOCK_NAMES;
        const scanDate = market === 'TW' ? get().tw.scanDate : get().cn.scanDate;

        // Get active strategy for the scan
        const activeStrategy = useSettingsStore.getState().getActiveStrategy();
        const strategyPayload = activeStrategy.isBuiltIn
          ? { strategyId: activeStrategy.id }
          : { thresholds: activeStrategy.thresholds };

        set(s => ({
          [mKey]: { ...s[mKey], isScanning: true, progress: 0, scanningStock: '取得股票清單中...', scanningIndex: 0, scanningTotal: 0, error: null },
        }));

        try {
          // ── Step 1: Fetch complete stock list ──────────────────────────────
          const listRes = await fetch(`/api/scanner/list?market=${market}`);
          if (!listRes.ok) throw new Error('無法取得股票清單');
          const listJson = await listRes.json() as { stocks: Array<{ symbol: string; name: string }> };
          const stocks = listJson.stocks ?? [];
          const total  = stocks.length;

          set(s => ({
            [mKey]: { ...s[mKey], scanningStock: '分析股票中...', scanningTotal: total, scanningIndex: 0 },
          }));

          // ── Step 2: Split into 2 parallel chunks ───────────────────────────
          const half   = Math.ceil(total / 2);
          const chunk1 = stocks.slice(0, half);
          const chunk2 = stocks.slice(half);

          // Progress: event-driven, not timer-based
          let completedChunks = 0;
          const updateProgress = (pct: number, stockName: string, idx: number) => {
            set(s => ({ [mKey]: { ...s[mKey], progress: pct, scanningStock: stockName, scanningIndex: idx } }));
          };
          updateProgress(5, names[0], 1);

          const scanChunk = async (chunk: Array<{ symbol: string; name: string }>, chunkIdx: number) => {
            const res = await fetch('/api/scanner/chunk', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ market, stocks: chunk, ...strategyPayload, ...(scanDate ? { date: scanDate } : {}) }),
            });
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              throw new Error((j as { error?: string }).error ?? '掃描失敗');
            }
            const j = await res.json() as { results?: StockScanResult[]; marketTrend?: TrendState };
            return { results: j.results ?? [], marketTrend: j.marketTrend ?? null };
          };

          // ── Step 3: Run both chunks in parallel ────────────────────────────
          updateProgress(10, `掃描第1批 (${chunk1.length}檔)`, 0);
          const [r1, r2] = await Promise.allSettled([
            scanChunk(chunk1, 0).then(r => { completedChunks++; updateProgress(completedChunks === 1 ? 50 : 88, `第${completedChunks}批完成`, half * completedChunks); return r; }),
            scanChunk(chunk2, 1).then(r => { completedChunks++; updateProgress(completedChunks === 1 ? 50 : 88, `第${completedChunks}批完成`, total); return r; }),
          ]);

          // Use market trend from whichever chunk succeeded (should be the same)
          const marketTrend: TrendState =
            (r1.status === 'fulfilled' ? r1.value.marketTrend : null) ??
            (r2.status === 'fulfilled' ? r2.value.marketTrend : null) ??
            '多頭';

          const results: StockScanResult[] = [
            ...(r1.status === 'fulfilled' ? r1.value.results : []),
            ...(r2.status === 'fulfilled' ? r2.value.results : []),
          ].sort((a, b) =>
            b.sixConditionsScore !== a.sixConditionsScore
              ? b.sixConditionsScore - a.sixConditionsScore
              : b.changePercent - a.changePercent
          );

          // Log if either chunk failed
          if (r1.status === 'rejected') console.warn('[scanner] chunk1 failed:', r1.reason);
          if (r2.status === 'rejected') console.warn('[scanner] chunk2 failed:', r2.reason);

          const now = new Date().toISOString();

          // 計算 Top 3 推薦（與 TodayPicks 組件相同邏輯）
          const topPicks = results
            .filter(r => r.surgeScore != null && r.surgeScore >= 40)
            .map(r => {
              const aiBonus = r.aiRank != null && r.aiRank <= 5 ? (6 - r.aiRank) * 5 : 0;
              const winBonus = (r.histWinRate ?? 50) >= 60 ? 15 : (r.histWinRate ?? 50) >= 50 ? 5 : -10;
              return { ...r, _score: (r.surgeScore ?? 0) + aiBonus + winBonus };
            })
            .sort((a, b) => b._score - a._score)
            .slice(0, 3)
            .map(r => ({
              symbol: r.symbol, name: r.name,
              surgeScore: r.surgeScore ?? 0, surgeGrade: r.surgeGrade ?? 'D',
              sixConditionsScore: r.sixConditionsScore,
              histWinRate: r.histWinRate, price: r.price, changePercent: r.changePercent,
              aiRank: r.aiRank, aiReason: r.aiReason,
            }));

          const session: ScanSession = {
            id:          `${market}-${now}`,
            market,
            date:        now.split('T')[0],
            scanTime:    now,
            resultCount: results.length,
            results,
            topPicks,
          };

          const histKey = market === 'TW' ? 'twHistory' : 'cnHistory';
          const prev    = market === 'TW' ? get().twHistory : get().cnHistory;
          const newHist = [session, ...prev].slice(0, MAX_HISTORY);

          set(s => ({
            [mKey]:    { ...s[mKey], isScanning: false, progress: 100, scanningStock: '', results, lastScanTime: now, marketTrend, error: null },
            [histKey]: newHist,
          }));

          // Auto-trigger AI ranking for top results
          get().runAiRank(market);
        } catch (err) {
          set(s => ({
            [mKey]: { ...s[mKey], isScanning: false, error: err instanceof Error ? err.message : '未知錯誤' },
          }));
        }
      },

      runAiRank: async (market) => {
        const mKey = market === 'TW' ? 'tw' : 'cn';
        const results = get()[mKey].results;
        if (results.length === 0) return;

        // Take top 15 by surgeScore
        const top = [...results]
          .sort((a, b) => (b.surgeScore ?? 0) - (a.surgeScore ?? 0))
          .slice(0, 15)
          .filter(r => r.surgeScore != null && r.surgeComponents != null);

        if (top.length === 0) return;

        set({ aiRanking: { isRanking: true, error: null } });

        try {
          const payload = top.map(r => ({
            symbol: r.symbol,
            name: r.name,
            price: r.price,
            changePercent: r.changePercent,
            surgeScore: r.surgeScore ?? 0,
            surgeGrade: r.surgeGrade ?? 'D',
            surgeFlags: r.surgeFlags ?? [],
            sixConditionsScore: r.sixConditionsScore,
            trendState: r.trendState,
            trendPosition: r.trendPosition,
            components: r.surgeComponents ?? {},
          }));

          const res = await fetch('/api/scanner/ai-rank', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stocks: payload, market }),
          });

          if (!res.ok) throw new Error('AI ranking failed');
          const data = await res.json() as {
            rankings?: Array<{ symbol: string; rank: number; confidence: string; reason: string }>;
            marketComment?: string;
          };

          // Merge AI rankings into scan results
          if (data.rankings && data.rankings.length > 0) {
            const rankMap = new Map(data.rankings.map(r => [r.symbol, r]));
            const updated = results.map(r => {
              const ai = rankMap.get(r.symbol);
              if (!ai) return r;
              return {
                ...r,
                aiRank: ai.rank,
                aiConfidence: ai.confidence as 'high' | 'medium' | 'low',
                aiReason: ai.reason,
              };
            });
            set(s => ({ [mKey]: { ...s[mKey], results: updated } }));
          }

          set({ aiRanking: { isRanking: false, error: null } });
        } catch (err) {
          set({ aiRanking: { isRanking: false, error: err instanceof Error ? err.message : 'AI排名失敗' } });
        }
      },
    }),
    {
      name: 'scanner-v4',
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({
        twHistory:    compactHistory(s.twHistory),
        cnHistory:    compactHistory(s.cnHistory),
        twResults:    compactResults(s.tw.results, 20),
        cnResults:    compactResults(s.cn.results, 20),
        twLastScan:   s.tw.lastScanTime,
        cnLastScan:   s.cn.lastScanTime,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Merge persisted flat fields back into nested market state
        const p = state as unknown as Record<string, unknown>;
        const twResults = Array.isArray(p.twResults) ? (p.twResults as StockScanResult[]) : [];
        const cnResults = Array.isArray(p.cnResults) ? (p.cnResults as StockScanResult[]) : [];
        const twLastScan = typeof p.twLastScan === 'string' ? p.twLastScan : null;
        const cnLastScan = typeof p.cnLastScan === 'string' ? p.cnLastScan : null;
        state.tw = { ...DEFAULT_TW, results: twResults, lastScanTime: twLastScan };
        state.cn = { ...DEFAULT_CN, results: cnResults, lastScanTime: cnLastScan };
      },
    }
  )
);
