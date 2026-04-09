import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { StockScanResult, ScanSession, MarketId, sanitizeScanResult, ScanDiagnostics, createEmptyDiagnostics, mergeDiagnostics, diagnosticsSummary } from '@/lib/scanner/types';
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
        try {
          // Clear old scanner data to free space
          localStorage.removeItem('scanner-v3');
          localStorage.removeItem('scanner-v2');
          localStorage.removeItem('scanner-v1');
          localStorage.setItem(name, value);
        } catch { /* storage still full after cleanup */ }
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
    .sort((a, b) => b.sixConditionsScore - a.sixConditionsScore)
    .slice(0, topN)
    .map(r => ({
      ...r,
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

// Module-level abort controllers per market
const abortControllers: Record<MarketId, AbortController | null> = { TW: null, CN: null };

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
  cancelScan: (market: MarketId) => void;
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

      cancelScan: (market) => {
        const ctrl = abortControllers[market];
        if (ctrl) {
          ctrl.abort();
          abortControllers[market] = null;
        }
        const mKey = market === 'TW' ? 'tw' : 'cn';
        set(s => ({
          [mKey]: { ...s[mKey], isScanning: false, progress: 0, scanningStock: '', error: '已取消掃描' },
        }));
      },

      runScan: async (market) => {
        // Cancel any in-flight scan for this market
        if (abortControllers[market]) abortControllers[market]!.abort();
        const abortCtrl = new AbortController();
        abortControllers[market] = abortCtrl;
        const signal = abortCtrl.signal;

        const mKey  = market === 'TW' ? 'tw' : 'cn';
        const names = market === 'TW' ? TW_STOCK_NAMES : CN_STOCK_NAMES;
        const scanDate = market === 'TW' ? get().tw.scanDate : get().cn.scanDate;

        // Get active strategy for the scan
        const activeStrategy = useSettingsStore.getState().getActiveStrategy();
        const strategyPayload = activeStrategy.isBuiltIn
          ? { strategyId: activeStrategy.id }
          : { thresholds: activeStrategy.thresholds };

        set(s => ({
          [mKey]: { ...s[mKey], isScanning: true, progress: 0, scanningStock: '載入掃描結果...', scanningIndex: 0, scanningTotal: 0, error: null },
        }));

        try {
          // ── Step 0: Try loading pre-computed cron results ─────────────────
          const targetDate = scanDate || new Date().toISOString().split('T')[0];
          try {
            const savedRes = await fetch(
              `/api/scanner/results?market=${market}&direction=long&date=${targetDate}`,
              { signal },
            );
            if (savedRes.ok) {
              const savedJson = await savedRes.json() as {
                sessions?: Array<{
                  results?: StockScanResult[];
                  scanTime?: string;
                  resultCount?: number;
                }>;
              };
              const session = savedJson.sessions?.[0];
              if (session && session.results && session.results.length > 0) {
                const results = session.results.map(sanitizeScanResult);
                const now = session.scanTime || new Date().toISOString();
                set(s => ({
                  [mKey]: {
                    ...s[mKey],
                    isScanning: false,
                    progress: 100,
                    scanningStock: '',
                    results,
                    lastScanTime: now,
                    marketTrend: '多頭',
                    error: null,
                    scanningTotal: results.length,
                  },
                }));
                abortControllers[market] = null;
                return;
              }
            }
          } catch {
            // Pre-computed results unavailable, fall back to real-time scan
          }

          // ── Step 1: 粗掃（全市場快照，< 3 秒） ─────────────────────────
          set(s => ({
            [mKey]: { ...s[mKey], scanningStock: '全市場粗掃中...' },
          }));

          const coarseRes = await fetch('/api/scanner/coarse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ market, direction: 'long' }),
            signal,
          });

          if (!coarseRes.ok) {
            const j = await coarseRes.json().catch(() => ({}));
            throw new Error((j as { error?: string }).error ?? '粗掃失敗');
          }

          interface CoarseCandidateItem { symbol: string; name: string }
          const coarseJson = await coarseRes.json() as {
            total?: number;
            candidateCount?: number;
            candidates?: CoarseCandidateItem[];
            scanTimeMs?: number;
          };

          const coarseCandidates = coarseJson.candidates ?? [];
          const coarseTotal = coarseJson.total ?? 0;

          set(s => ({
            [mKey]: {
              ...s[mKey],
              progress: 15,
              scanningStock: `粗掃完成：${coarseTotal} 檔中找到 ${coarseCandidates.length} 檔候選`,
              scanningTotal: coarseCandidates.length,
            },
          }));

          // 如果粗掃沒有候選，直接結束
          if (coarseCandidates.length === 0) {
            set(s => ({
              [mKey]: {
                ...s[mKey],
                isScanning: false, progress: 100, scanningStock: '',
                results: [], lastScanTime: new Date().toISOString(),
                marketTrend: '多頭', error: `無符合粗篩條件的股票（共掃描 ${coarseTotal} 檔）`,
              },
            }));
            abortControllers[market] = null;
            return;
          }

          // ── Step 2: 精掃（候選池，讀完整 K 線跑六條件） ─────────────────
          set(s => ({
            [mKey]: { ...s[mKey], progress: 20, scanningStock: `精掃 ${coarseCandidates.length} 檔候選中...` },
          }));

          const stocks = coarseCandidates.map(c => ({ symbol: c.symbol, name: c.name }));

          const scanChunk = async (chunk: Array<{ symbol: string; name: string }>) => {
            const res = await fetch('/api/scanner/chunk', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ market, stocks: chunk, ...strategyPayload, ...(scanDate ? { date: scanDate } : {}) }),
              signal,
            });
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              throw new Error((j as { error?: string }).error ?? '精掃失敗');
            }
            const j = await res.json() as { results?: StockScanResult[]; marketTrend?: TrendState; diagnostics?: ScanDiagnostics; dataDate?: string };
            return {
              results: (j.results ?? []).map(sanitizeScanResult),
              marketTrend: j.marketTrend ?? null,
              diagnostics: j.diagnostics ?? createEmptyDiagnostics(),
              dataDate: j.dataDate ?? undefined,
            };
          };

          // 候選池通常 30-100 檔，可以一次送（不需拆分）
          const fineResult = await scanChunk(stocks);

          set(s => ({
            [mKey]: { ...s[mKey], progress: 88, scanningStock: '精掃完成' },
          }));

          const marketTrend: TrendState = fineResult.marketTrend ?? '多頭';
          const dataDate: string | undefined = fineResult.dataDate;
          const combinedDiag = fineResult.diagnostics;

          const results: StockScanResult[] = fineResult.results
            .sort((a, b) =>
              b.sixConditionsScore !== a.sixConditionsScore
                ? b.sixConditionsScore - a.sixConditionsScore
                : b.changePercent - a.changePercent
            );

          // 結果為空時：多態區分原因，顯示具體原因+建議
          if (results.length === 0) {
            const diagMsg = diagnosticsSummary(combinedDiag);
            let errorMsg: string;

            if (combinedDiag.totalStocks === 0 || combinedDiag.processedCount === 0) {
              // 精掃完全失敗
              errorMsg = '精掃無法處理任何候選股票。\n'
                + '可能原因：K 線資料庫尚未建立或 Blob 存取異常。\n'
                + '建議：等待 2-3 分鐘後重試，或切換到「歷史紀錄」查看收盤後結果。';
            } else if (combinedDiag.dataMissing > combinedDiag.totalStocks * 0.3) {
              // 大量缺資料
              const pct = Math.round(combinedDiag.dataMissing / combinedDiag.totalStocks * 100);
              const twCronTime = '每天 13:45';
              const cnCronTime = '每天 15:15';
              const cronTime = market === 'TW' ? twCronTime : cnCronTime;
              errorMsg = `${pct}% 股票缺少 K 線資料（${combinedDiag.dataMissing}/${combinedDiag.totalStocks} 檔）。\n`
                + `可能原因：今日收盤資料尚未下載完成。\n`
                + `建議：系統會在${cronTime}自動下載，完成後即可正常掃描。`;
            } else if (combinedDiag.filteredOut > 0 && combinedDiag.apiFailed === 0) {
              // 正常：全被過濾
              errorMsg = `今日無符合六條件的股票（已掃描 ${combinedDiag.processedCount} 檔，全部被過濾）。\n`
                + '這是正常現象，表示目前無明確做多/做空訊號。';
            } else if (combinedDiag.apiFailed > 0) {
              // API 錯誤
              errorMsg = `部分 API 請求失敗（${combinedDiag.apiFailed} 次）。\n`
                + `可能原因：資料源暫時不穩定。\n`
                + `建議：等待 1-2 分鐘後重試。（${diagMsg}）`;
            } else {
              errorMsg = `掃描完成但無結果。（${diagMsg}）\n建議：重試一次或切換到歷史紀錄。`;
            }

            set(s => ({
              [mKey]: {
                ...s[mKey], isScanning: false, progress: 100, scanningStock: '',
                results: [], marketTrend,
                lastScanTime: combinedDiag.filteredOut > 0 ? new Date().toISOString() : s[mKey].lastScanTime,
                error: errorMsg,
              },
            }));
            return;
          }

          const now = new Date().toISOString();

          // 計算 Top 3 推薦（與 TodayPicks 組件相同邏輯）
          const topPicks = results
            .sort((a, b) => b.sixConditionsScore - a.sixConditionsScore || b.changePercent - a.changePercent)
            .slice(0, 3)
            .map(r => ({
              symbol: r.symbol, name: r.name,
              sixConditionsScore: r.sixConditionsScore,
              histWinRate: r.histWinRate, price: r.price, changePercent: r.changePercent,
              aiRank: r.aiRank, aiReason: r.aiReason,
            }));

          const session: ScanSession = {
            id:          `${market}-${now}`,
            market,
            date:        dataDate || scanDate || now.split('T')[0],
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

          // ── 台股：異步補充籌碼面資料 ──────────────────────────────────────
          if (market === 'TW' && results.length > 0) {
            // 如果是週末，往回找到最近的交易日
            let chipDate = scanDate || now.split('T')[0];
            const cd = new Date(chipDate + 'T00:00:00');
            if (cd.getDay() === 0) chipDate = new Date(cd.getTime() - 2 * 86400000).toISOString().slice(0, 10);
            else if (cd.getDay() === 6) chipDate = new Date(cd.getTime() - 1 * 86400000).toISOString().slice(0, 10);

            // Fire-and-forget with proper error handling
            void (async () => {
              try {
                const chipRes = await fetch(`/api/chip?date=${chipDate}`);
                if (!chipRes.ok) return;
                const chipJson = await chipRes.json() as {
                  data?: Array<{ symbol: string; chipScore: number; chipGrade: string; chipSignal: string; chipDetail: string; foreignBuy: number; trustBuy: number; dealerBuy: number; marginNet: number; shortNet: number; marginBalance: number; shortBalance: number; dayTradeRatio: number; largeTraderNet: number }>;
                };
                if (!chipJson.data) return;
                const chipMap = new Map(chipJson.data.map(d => [d.symbol, d]));
                const currentResults = get()[mKey].results;
                const enriched = currentResults.map(r => {
                  const sym = r.symbol.replace(/\.(TW|TWO)$/i, '');
                  const chip = chipMap.get(sym);
                  if (!chip) return r;
                  return { ...r, ...chip };
                });
                set(s => ({ [mKey]: { ...s[mKey], results: enriched } }));
              } catch {
                // 籌碼查詢失敗不影響主流程
              }
            })();
          }
        } catch (err) {
          // Don't show error if user cancelled
          if (err instanceof DOMException && err.name === 'AbortError') return;
          const msg = err instanceof Error ? err.message : '未知錯誤';

          // 解析 API 回傳的結構化錯誤（已包含原因+建議）
          // 如果 msg 本身已有「建議」，直接用
          if (msg.includes('建議')) {
            set(s => ({ [mKey]: { ...s[mKey], isScanning: false, error: msg } }));
          } else {
            // 通用錯誤分類
            const lowerMsg = msg.toLowerCase();
            // Timeout / Network 統一處理：
            //   Chrome: "Failed to fetch", Firefox: "NetworkError when attempting to fetch resource"
            //   都可能是 Vercel function 300s 超時、行動網路中斷、或 CORS 問題
            const isConnectionError = lowerMsg.includes('failed to fetch')
              || lowerMsg.includes('networkerror')
              || lowerMsg.includes('network error')
              || lowerMsg.includes('timeout')
              || lowerMsg.includes('etimedout')
              || lowerMsg.includes('err_')
              || msg.includes('504') || msg.includes('502') || msg.includes('503');
            const is404 = msg.includes('404') || msg.includes('尚無');

            let userMsg: string;
            if (isConnectionError) {
              userMsg = '掃描請求失敗（伺服器無回應）。\n'
                + '可能原因：伺服器處理逾時、行動網路不穩、或系統正在部署中。\n'
                + '建議：\n'
                + '① 等待 30 秒後重試\n'
                + '② 若持續失敗，切換到「歷史紀錄」查看收盤後結果\n'
                + '③ 檢查網路連線是否正常';
            } else if (is404) {
              userMsg = msg;
            } else {
              userMsg = `掃描異常：${msg.slice(0, 150)}\n建議：重試一次，若持續失敗請稍後再試。`;
            }

            set(s => ({ [mKey]: { ...s[mKey], isScanning: false, error: userMsg } }));
          }
        } finally {
          abortControllers[market] = null;
        }
      },

      runAiRank: async (market) => {
        const mKey = market === 'TW' ? 'tw' : 'cn';
        const results = get()[mKey].results;
        if (results.length === 0) return;

        // Take top 15 by sixConditionsScore
        const top = [...results]
          .sort((a, b) => b.sixConditionsScore - a.sixConditionsScore)
          .slice(0, 15);

        if (top.length === 0) return;

        set({ aiRanking: { isRanking: true, error: null } });

        try {
          const payload = top.map(r => ({
            symbol: r.symbol,
            name: r.name,
            price: r.price,
            changePercent: r.changePercent,
            sixConditionsScore: r.sixConditionsScore,
            trendState: r.trendState,
            trendPosition: r.trendPosition,
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

        // 清理假紀錄：刪除 date > 最後交易日的掃描歷史
        // （盤前舊 bug 會用「今天」當 date，但市場還沒開盤，實際數據是上一個交易日的）
        // 保守邏輯：只跳過週末，工作日一律視為有效（避免因時區/時間差誤刪紀錄）
        const getClientLastTradingDay = (): string => {
          const now = new Date();
          const dow = now.getDay(); // 0=Sun, 6=Sat
          if (dow === 0) { now.setDate(now.getDate() - 2); }
          else if (dow === 6) { now.setDate(now.getDate() - 1); }
          return now.toISOString().split('T')[0];
        };
        const lastTradeDay = getClientLastTradingDay();
        const cleanHistory = (sessions: ScanSession[]) =>
          sessions.filter(s => s.date <= lastTradeDay);
        if (state.twHistory) state.twHistory = cleanHistory(state.twHistory);
        if (state.cnHistory) state.cnHistory = cleanHistory(state.cnHistory);
      },
    }
  )
);
