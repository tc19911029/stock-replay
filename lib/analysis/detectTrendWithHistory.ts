/**
 * detectTrend 歷史追蹤包裝（v12 議題 21 / 36 / 47）
 *
 * 既有 `detectTrend()` 只回傳當前 trend state，但 v12 多處需要：
 * - 議題 21：B/C/E/J/L/M/P 訊號的「曾跌破/沒跌破 MA5」只看翻多事件 T 之後
 * - 議題 36：scan record 持久化 `lastTrendChangeDate` 供系統重啟回讀
 * - 議題 47/55/99：pivot gate 需要「最近 1 pivot high + 1 pivot low」（不限 T）
 * - 議題 9 + 整體合併檢查 B：取消 anti-flicker，純書本即時翻多就翻多
 *
 * 本 module **不修改** 既有 detectTrend()，純包裝：對歷史資料逐日呼叫 detectTrend
 * 找出最近一次 trend state 變化的時點。
 */

import type { CandleWithIndicators } from '@/types';

import { detectTrend, findPivots, type TrendState } from './trendAnalysis';

export interface TrendWithHistory {
  /** 當前 trend state */
  state: TrendState;
  /**
   * 最近一次 trend 變化發生的 candle index
   * - 若全段都是同一 state，回傳查詢起點 index（lookback 邊界）
   * - 若 index < 20 永遠回 -1（detectTrend 規則）
   */
  lastChangeIndex: number;
  /** 最近一次 trend 變化的日期（candle.date）；若 lastChangeIndex < 0 則回 null */
  lastChangeDate: string | null;
  /** 變化前的 trend state（首次出現時為 null）*/
  previousState: TrendState | null;
  /**
   * 「翻多事件 T」對應 index — 最近一次任何 state → '多頭' 的事件
   * 用於議題 21 多頭軌訊號觀察期；若沒有翻多事件回 null
   */
  lastTrendUpDate: string | null;
  lastTrendUpIndex: number;
}

/**
 * 包裝 detectTrend 加歷史追蹤。
 *
 * @param candles 完整 K 線（含 indicators，需有 ma5 才能跑 detectTrend）
 * @param index 查詢時點
 * @param lookback 往回掃描的最大 candle 數（預設 60；超過時取最舊 candle 為起點）
 */
export function detectTrendWithHistory(
  candles: ReadonlyArray<CandleWithIndicators>,
  index: number,
  lookback = 60,
): TrendWithHistory {
  const empty: TrendWithHistory = {
    state: '盤整',
    lastChangeIndex: -1,
    lastChangeDate: null,
    previousState: null,
    lastTrendUpDate: null,
    lastTrendUpIndex: -1,
  };

  if (index < 20 || candles.length === 0 || index >= candles.length) {
    return empty;
  }

  // 把 readonly 轉成 mutable 給 detectTrend（既有 API）
  const mutableCandles = candles as CandleWithIndicators[];

  const currentState = detectTrend(mutableCandles, index);
  const start = Math.max(20, index - lookback);

  let lastChangeIndex = -1;
  let previousState: TrendState | null = null;
  let lastTrendUpIndex = -1;

  // 從查詢點往回掃，找最近一次 state 變化
  let cursor = currentState;
  for (let i = index - 1; i >= start; i--) {
    const past = detectTrend(mutableCandles, i);
    if (past !== cursor) {
      // 在 i+1 變成 cursor，這就是最近的變化點
      lastChangeIndex = i + 1;
      previousState = past;
      break;
    }
    cursor = past;
  }

  // 沒找到變化 → 整個 lookback 期間都是同一 state
  if (lastChangeIndex < 0 && cursor === currentState) {
    lastChangeIndex = start;
  }

  // 找翻多事件 T：最近一次任何 → '多頭' 的事件
  if (currentState === '多頭') {
    lastTrendUpIndex = lastChangeIndex; // 當前是多頭，最近的變化就是翻多
  } else {
    // 當前不是多頭 → 往回找最近一次「非多頭 → 多頭」事件
    let prev: TrendState = currentState;
    for (let i = index - 1; i >= start; i--) {
      const past: TrendState = detectTrend(mutableCandles, i);
      if (past === '多頭' && prev !== '多頭') {
        lastTrendUpIndex = i;
        break;
      }
      prev = past;
    }
  }

  const lastChangeDate =
    lastChangeIndex >= 0 && candles[lastChangeIndex]
      ? candles[lastChangeIndex].date
      : null;

  const lastTrendUpDate =
    lastTrendUpIndex >= 0 && candles[lastTrendUpIndex]
      ? candles[lastTrendUpIndex].date
      : null;

  return {
    state: currentState,
    lastChangeIndex,
    lastChangeDate,
    previousState,
    lastTrendUpDate,
    lastTrendUpIndex,
  };
}

/**
 * 議題 47/55/99：找最近 1 個確認 pivot high + 1 個確認 pivot low（不限 T）
 *
 * 用於多頭軌訊號（B/P/C/L/M）的「上漲一波後」 gate — 純書本書本邏輯
 * 「最近的一波」，不是「翻多以來最早的一波」。
 *
 * 注意：本函數使用 trendAnalysis.findPivots 的「已確認 pivot」（不含 provisional）。
 *
 * @returns 是否存在「最近 pivot high + low」結構
 */
export function hasRecentPivotPair(
  candles: ReadonlyArray<CandleWithIndicators>,
  index: number,
): boolean {
  // findPivots（已確認版本），需要至少 1 個 high + 1 個 low
  const pivots = findPivots(candles as CandleWithIndicators[], index, 8, false);
  const hasHigh = pivots.some(p => p.type === 'high');
  const hasLow = pivots.some(p => p.type === 'low');
  return hasHigh && hasLow;
}
