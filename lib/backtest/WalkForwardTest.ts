/**
 * WalkForwardTest.ts — 步進式向前回測框架 (#13)
 *
 * 解決的問題：
 * 「訓練集」與「測試集」用同一批資料 → 過度擬合（in-sample bias）
 *
 * 做法：
 * - 將多個歷史掃描 session 切分成滾動式訓練/測試窗口
 * - 在訓練窗口上評估策略表現，再驗證測試窗口
 * - 多窗口聚合後，觀察策略是否在 out-of-sample 仍然穩定
 *
 * 輸入格式：
 * - sessions: 按日期排序的歷史掃描批次，每批含 scanResults + forwardCandlesMap
 * - trainSize: 訓練窗口包含幾個 session
 * - testSize:  測試窗口包含幾個 session
 * - stepSize:  每次窗口向前滾動幾個 session
 */

import {
  BacktestStats,
  BacktestStrategyParams,
  DEFAULT_STRATEGY,
  calcBacktestStats,
  runBatchBacktest,
} from './BacktestEngine';
import { ForwardCandle, StockScanResult } from '@/lib/scanner/types';

// ── Types ────────────────────────────────────────────────────────────────────

/** 單一步進窗口的訓練+測試結果 */
export interface WalkForwardWindow {
  windowIndex: number;
  // ── 訓練窗口 ──
  trainSessions: string[];       // 訓練窗口包含的 session 日期
  trainStats:    BacktestStats | null;
  // ── 測試窗口 ──
  testSessions:  string[];       // 測試窗口包含的 session 日期
  testStats:     BacktestStats | null;
}

/** 完整的步進式回測結果 */
export interface WalkForwardResult {
  windows:           WalkForwardWindow[];
  // ── 跨窗口聚合（out-of-sample） ──
  aggregateTestStats: BacktestStats | null;
  // ── 穩健性指標 ──
  robustnessScore:    number;   // 測試窗口勝率 > 50% 的比例 (0-100%)
  // ── 訓練/測試績效比 ──
  efficiencyRatio:    number | null;  // testAvgReturn / trainAvgReturn（越接近1越好）
}

/** 單一掃描批次 */
export interface WalkForwardSession {
  date:             string;
  scanResults:      StockScanResult[];
  forwardCandlesMap: Record<string, ForwardCandle[]>;
}

/** 步進式回測參數 */
export interface WalkForwardParams {
  sessions:  WalkForwardSession[];  // 按日期升冪排列
  trainSize: number;                // 訓練窗口大小（session 數）
  testSize:  number;                // 測試窗口大小（session 數）
  stepSize:  number;                // 每步滾動幾個 session（預設 1）
  strategy:  BacktestStrategyParams;
}

// ── Engine ───────────────────────────────────────────────────────────────────

/**
 * 合併多個 session 的掃描結果與 K 線圖
 */
function mergeSessions(sessions: WalkForwardSession[]): {
  scanResults:       StockScanResult[];
  forwardCandlesMap: Record<string, ForwardCandle[]>;
} {
  const seen = new Set<string>();
  const scanResults: StockScanResult[] = [];
  const forwardCandlesMap: Record<string, ForwardCandle[]> = {};

  for (const s of sessions) {
    for (const r of s.scanResults) {
      // 同一檔股票在不同日期可能重複出現，保留最新（後出現）的一筆
      const key = `${r.symbol}:${s.date}`;
      if (!seen.has(key)) {
        seen.add(key);
        scanResults.push(r);
      }
    }
    for (const [sym, candles] of Object.entries(s.forwardCandlesMap)) {
      // 對同一個 symbol，合併所有 candles（去重後依日期排序）
      const existing = forwardCandlesMap[sym] ?? [];
      const combined = [...existing, ...candles];
      const deduped = Array.from(
        new Map(combined.map(c => [c.date, c])).values(),
      ).sort((a, b) => a.date.localeCompare(b.date));
      forwardCandlesMap[sym] = deduped;
    }
  }

  return { scanResults, forwardCandlesMap };
}

/**
 * 執行步進式向前回測
 *
 * @param params  回測參數（見 WalkForwardParams）
 * @returns       每個滾動窗口的訓練/測試統計，以及跨窗口聚合結果
 *
 * @example
 * ```ts
 * const result = runWalkForward({
 *   sessions:  historicalSessions,   // 20 個月的掃描批次
 *   trainSize: 12,                   // 12 個月訓練
 *   testSize:  3,                    // 3 個月測試
 *   stepSize:  3,                    // 每季滾動一次
 *   strategy:  DEFAULT_STRATEGY,
 * });
 * console.log(result.robustnessScore);  // 測試窗口穩定性
 * ```
 */
export function runWalkForward(params: WalkForwardParams): WalkForwardResult {
  const {
    sessions,
    trainSize,
    testSize,
    stepSize = 1,
    strategy = DEFAULT_STRATEGY,
  } = params;

  const windows: WalkForwardWindow[] = [];
  const allTestTrades = [];

  let start = 0;
  while (start + trainSize + testSize <= sessions.length) {
    const trainSessions = sessions.slice(start, start + trainSize);
    const testSessions  = sessions.slice(start + trainSize, start + trainSize + testSize);

    // ── 訓練窗口 ──
    const trainMerged = mergeSessions(trainSessions);
    const { trades: trainTrades, skippedCount: trainSkipped } = runBatchBacktest(
      trainMerged.scanResults,
      trainMerged.forwardCandlesMap,
      strategy,
    );
    const trainStats = calcBacktestStats(trainTrades, trainSkipped);

    // ── 測試窗口（out-of-sample）──
    const testMerged = mergeSessions(testSessions);
    const { trades: testTrades, skippedCount: testSkipped } = runBatchBacktest(
      testMerged.scanResults,
      testMerged.forwardCandlesMap,
      strategy,
    );
    const testStats = calcBacktestStats(testTrades, testSkipped);

    allTestTrades.push(...testTrades);

    windows.push({
      windowIndex:   windows.length,
      trainSessions: trainSessions.map(s => s.date),
      trainStats,
      testSessions:  testSessions.map(s => s.date),
      testStats,
    });

    start += stepSize;
  }

  // ── 跨窗口聚合 ────────────────────────────────────────────────────────────
  const aggregateTestStats = calcBacktestStats(allTestTrades);

  // 穩健性：有幾個測試窗口的勝率超過 50%
  const windowsWithStats = windows.filter(w => w.testStats !== null);
  const robustWindows    = windowsWithStats.filter(w => (w.testStats?.winRate ?? 0) > 50);
  const robustnessScore  = windowsWithStats.length > 0
    ? +(robustWindows.length / windowsWithStats.length * 100).toFixed(1)
    : 0;

  // 效率比：test 平均報酬 / train 平均報酬（愈接近 1 代表訓練集表現可被複製）
  const avgTrainReturn = windows.reduce(
    (s, w) => s + (w.trainStats?.avgNetReturn ?? 0), 0,
  ) / (windows.length || 1);
  const avgTestReturn = windows.reduce(
    (s, w) => s + (w.testStats?.avgNetReturn ?? 0), 0,
  ) / (windows.length || 1);
  const efficiencyRatio = (avgTrainReturn !== 0)
    ? +(avgTestReturn / avgTrainReturn).toFixed(3)
    : null;

  return {
    windows,
    aggregateTestStats,
    robustnessScore,
    efficiencyRatio,
  };
}
