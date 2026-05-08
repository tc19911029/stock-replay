/**
 * v12 Step 5 停利實作（v12 Phase 1.10）
 *
 * 書本依據：
 * - 5 步驟 步驟 5 第 2-4 章（紀律 / 獲利目標 / K 棒訊號）p.295-330
 * - 寶典 Part 12-1「3 階段獲利目標」p.745
 * - 寶典 Part 11-2 短線 20 守則 #5-#8 p.711-712
 *
 * Step 5 三種停利目標：
 * - ①紀律：跟 Step 3+4 同一條規則「賺錢狀態」版（不獨立實作）
 * - ②獲利目標：10% / 乖離 15% / 型態目標價
 * - ③K 棒訊號：寶典 15 種多轉空祕笈圖 + 抓線圖 8 K 線下殺
 *
 * v12 議題：
 * - 議題 B：B/P 達 10% 切換進階紀律（已在 v12Operation.ts 實作）
 * - 議題 Step 5 ②：乖離 15% 切 MA5（不直接停利）
 * - 議題 Step 5 ③ G：K 棒訊號累計獲利 > 0% 才啟用
 * - 議題 88：寶典 #7/#8 急漲後高檔反轉（連 3 紅 + 大量長黑 K + 跌破前 K low）
 */

import type { CandleWithIndicators } from '../../types';

import type { V12Letter } from '../analysis/v12Signals';

// ── Step 5 ② 獲利目標停利 ───────────────────────────────────────────────

export interface TakeProfitInputs {
  letter: V12Letter;
  entryPrice: number;
  todayClose: number;
  todayMA20?: number | null;
  /** N 訊號用：型態目標價 */
  patternTargetPrice?: number;
}

export interface TakeProfitResult {
  triggered: boolean;
  reason?:
    | 'pattern-target'      // ② 達型態目標價
    | 'high-deviation'      // ② 乖離 ≥ 15%（切 MA5，不直接停利）
    | 'profit-target-10'    // ② 達 10% 獲利（切換進階紀律 flag）
    | 'high-vol-black-k';   // ③ 寶典 #7/#8 急漲反轉
  /** 進階紀律是否啟用（B/P MA5 切換）*/
  enhancedDisciplineEnabled?: boolean;
  /** 操作模式建議切換為（Step 4 ③）*/
  modeRecommendation?: 'short-bias-MA5' | 'long-mode' | null;
  detail?: string;
}

/**
 * Step 5 ② 獲利目標停利判定
 *
 * 注意：本函數**不直接出場**（除了型態目標價）。其他兩條件只切換紀律：
 * - 達 10%：啟用 B/P 寶典 #5/#6 進階紀律
 * - 乖離 ≥ 15%：建議切 MA5 跟隨（議題 Step 5 ②）
 */
export function checkTakeProfitTargets(inputs: TakeProfitInputs): TakeProfitResult {
  const { letter, entryPrice, todayClose, todayMA20, patternTargetPrice } = inputs;

  const profitPct = (todayClose - entryPrice) / entryPrice;

  // 型態目標價（N 訊號）→ 直接停利
  if (patternTargetPrice != null && todayClose >= patternTargetPrice) {
    return {
      triggered: true,
      reason: 'pattern-target',
      detail: `達型態目標價 ${patternTargetPrice.toFixed(2)}（停利）`,
    };
  }

  // 乖離 ≥ 15% → 切 MA5（不直接停利，議題 Step 5 ②）
  if (todayMA20 != null && todayMA20 > 0) {
    const deviation = (todayClose - todayMA20) / todayMA20;
    if (deviation >= 0.15) {
      return {
        triggered: false,
        reason: 'high-deviation',
        modeRecommendation: 'short-bias-MA5',
        detail: `乖離 ${(deviation * 100).toFixed(2)}% ≥ 15%，建議切 MA5 跟隨`,
      };
    }
  }

  // 達 10% → 啟用 B/P 進階紀律（議題 Step 5 ② / 衝突 α）
  if (profitPct >= 0.10) {
    return {
      triggered: false,
      reason: 'profit-target-10',
      enhancedDisciplineEnabled: letter === 'B' || letter === 'P',
      detail: `獲利達 10%（${(profitPct * 100).toFixed(2)}%）— ${letter === 'B' || letter === 'P' ? '啟用寶典 #5/#6 進階紀律' : '可考慮升級長線'}`,
    };
  }

  return { triggered: false };
}

// ── Step 5 ③ K 棒訊號（高檔反轉）────────────────────────────────────────

export interface KBarSignalInputs {
  todayCandle: CandleWithIndicators;
  yesterdayCandle: CandleWithIndicators;
  twoDaysAgoCandle?: CandleWithIndicators;
  threeDaysAgoCandle?: CandleWithIndicators;
  /** 持倉中累計獲利（議題 G：> 0% 才啟用 K 棒訊號）*/
  cumulativeProfit: number;
  /** 是否末升段（議題 13）*/
  isEndPhase?: boolean;
}

export interface KBarSignalResult {
  triggered: boolean;
  signalType?:
    | 'piercing-black'         // 穿心黑 K（寶典 #11 強覆蓋）
    | 'long-upper-shadow'      // 高檔長上影（寶典圖 6）
    | 'three-red-with-shadow'  // 連 3 紅 + 上影（寶典 #7）
    | 'bearish-engulfing'      // 高檔長黑吞噬
    | 'high-vol-black-break';  // 寶典 #8 大量長黑 K 跌破前 K 低
  detail?: string;
}

/**
 * Step 5 ③ K 棒訊號偵測
 *
 * 議題 G：累計獲利 > 0% 才啟用（純書本「上漲一段後」）。
 *
 * 階段 1 實作高優先 4 個訊號（其他階段 2 補入）：
 * 1. 穿心黑 K（強覆蓋）— 抓線圖 8 K 線下殺 #5
 * 2. 高檔長上影 — 寶典圖 6
 * 3. 高檔長黑吞噬 — 抓線圖 #1
 * 4. 寶典 #8 急漲後大量長黑跌破前 K 低
 */
export function detectKBarExitSignal(inputs: KBarSignalInputs): KBarSignalResult {
  const { todayCandle, yesterdayCandle, twoDaysAgoCandle, cumulativeProfit, isEndPhase } = inputs;

  // 議題 G：累計獲利 > 0% 才啟用
  if (cumulativeProfit <= 0) {
    return { triggered: false };
  }

  // ── 1. 穿心黑 K（強覆蓋）—— 跌破前一日紅 K 的 1/2 位置 ──
  // 條件：今日是黑 K + 跌破昨日紅 K 中點 + 跌破前一日最低
  if (
    yesterdayCandle.close > yesterdayCandle.open &&  // 昨日紅 K
    todayCandle.close < todayCandle.open &&          // 今日黑 K
    todayCandle.close < (yesterdayCandle.open + yesterdayCandle.close) / 2 &&
    todayCandle.close < yesterdayCandle.low
  ) {
    return {
      triggered: true,
      signalType: 'piercing-black',
      detail: '③ 穿心黑 K（強覆蓋）— 跌破昨日紅 K 1/2 + 跌破昨日最低',
    };
  }

  // ── 2. 高檔長上影 ──
  // 條件：今日 K 線上影線比例 > 50% K 線全長 + 末升段或高檔
  const todayHigh = todayCandle.high;
  const todayLow = todayCandle.low;
  const todayClose = todayCandle.close;
  const todayBodyTop = Math.max(todayCandle.open, todayCandle.close);
  const upperShadowLen = todayHigh - todayBodyTop;
  const fullLen = todayHigh - todayLow;
  if (
    fullLen > 0 &&
    upperShadowLen / fullLen > 0.5 &&
    isEndPhase
  ) {
    return {
      triggered: true,
      signalType: 'long-upper-shadow',
      detail: `③ 高檔長上影（上影線占 ${((upperShadowLen / fullLen) * 100).toFixed(0)}% K 線全長）`,
    };
  }

  // ── 3. 高檔長黑吞噬（陰包陽）──
  // 條件：今日黑 K 包昨日紅 K（open > 昨 close、close < 昨 open）
  if (
    yesterdayCandle.close > yesterdayCandle.open &&  // 昨日紅 K
    todayCandle.close < todayCandle.open &&          // 今日黑 K
    todayCandle.open > yesterdayCandle.close &&      // 今日 open > 昨日 close（高開）
    todayCandle.close < yesterdayCandle.open         // 今日 close < 昨日 open（吞噬）
  ) {
    return {
      triggered: true,
      signalType: 'bearish-engulfing',
      detail: '③ 高檔長黑吞噬（陰包陽）',
    };
  }

  // ── 4. 寶典 #8 急漲後大量長黑跌破前 K 低（≥ 20% 累計獲利）──
  if (
    cumulativeProfit >= 0.20 &&
    todayCandle.close < todayCandle.open &&          // 今日黑 K
    yesterdayCandle.volume > 0 &&
    todayCandle.volume / yesterdayCandle.volume >= 1.3 &&  // 大量
    todayCandle.close < yesterdayCandle.low           // 跌破前 K 低
  ) {
    return {
      triggered: true,
      signalType: 'high-vol-black-break',
      detail: `③ 寶典 #8：上漲 ${(cumulativeProfit * 100).toFixed(0)}% + 大量長黑跌破前 K 低 → 全出`,
    };
  }

  return { triggered: false };
}
