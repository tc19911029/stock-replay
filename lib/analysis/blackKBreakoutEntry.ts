/**
 * 策略 H：突破大量黑 K 進場偵測
 *
 * 朱家泓《活用技術分析寶典》Part 11-1 8 種進場位置「位置 8：等突破大量黑 K」（p.699）：
 *   多頭上漲一波後，大量黑 K 跌破前一日 K 線最低點，或跌破 MA5，
 *   隨即（3 日內）出現大量紅 K 突破大量黑 K 的最高點，做多。
 *
 * 同時對應寶典 Part 12-4「18 種空轉多祕笈圖」第 9 圖「突破大量黑 K 買進」（p.806）。
 *
 * 用戶 Step 2 第 5 條「過大量黑 K 高」直接源頭。
 *
 * 條件：
 *   1. 多頭趨勢中（detectTrend === '多頭'）
 *   2. 過去 3 日內出現「大量黑 K」：黑 K + 量 ≥ 前日 ×1.3 + (跌破前一日 K 低 OR 跌破 MA5)
 *   3. 今日紅 K 實體 ≥ 2%
 *   4. 今日量 ≥ 前日 × 1.3
 *   5. 今日收盤突破大量黑 K 的最高點
 *
 * 不套戒律（strategyType='kline-pattern'）— 書本 Part 11-1 是直接列出的進場位置。
 */

import type { CandleWithIndicators } from '@/types';
import { detectTrend } from '@/lib/analysis/trendAnalysis';

export interface BlackKBreakoutResult {
  isBlackKBreakout: boolean;
  blackKHigh: number;          // 大量黑 K 的最高點（被突破的目標）
  blackKLow: number;           // 大量黑 K 最低點（停損參考）
  blackKDate: string;          // 大量黑 K 的日期
  blackKVolumeRatio: number;   // 大量黑 K 的量比
  bodyPct: number;             // 今日紅 K 實體
  volumeRatio: number;         // 今日量比
  daysSinceBlackK: number;     // 距大量黑 K 幾天（≤ 3）
  detail: string;
}

const MAX_DAYS_AFTER_BLACK_K = 3;   // 書本「3 日內」
const MIN_BLACK_K_BODY_PCT = 1.5;   // 黑 K 至少 1.5% 才算「大」（書本「大量長黑 K」之合理門檻）
const MIN_BLACK_K_VOL_RATIO = 1.3;  // 黑 K 量 ≥ 前日 × 1.3 才算「大量」

interface BlackKEvent {
  index: number;
  high: number;
  low: number;
  date: string;
  volumeRatio: number;
}

/**
 * 在 [idx-MAX_DAYS_AFTER_BLACK_K, idx-1] 區間內找最近一根「大量黑 K」。
 *
 * 「大量黑 K」定義：
 *   黑 K（close < open）
 *   實體 ≥ 1.5%
 *   量 ≥ 前日 × 1.3
 *   且：跌破前一日 K 線最低點 OR 跌破 MA5
 */
function findRecentLargeVolumeBlackK(
  candles: CandleWithIndicators[],
  idx: number,
): BlackKEvent | null {
  // 從最近往前找（idx-1 → idx-MAX_DAYS_AFTER_BLACK_K）
  // 找到第一根符合條件就回傳（最近的一根，書本「隨即（3 日內）」）
  const oldest = Math.max(1, idx - MAX_DAYS_AFTER_BLACK_K);
  let mostRecent: BlackKEvent | null = null;

  for (let i = idx - 1; i >= oldest; i--) {
    const cd = candles[i];
    const prev = candles[i - 1];
    if (!cd || !prev || prev.volume <= 0 || cd.open <= 0) continue;

    // 黑 K
    if (cd.close >= cd.open) continue;

    // 實體 ≥ MIN_BLACK_K_BODY_PCT
    const bodyPct = ((cd.open - cd.close) / cd.open) * 100;
    if (bodyPct < MIN_BLACK_K_BODY_PCT) continue;

    // 量 ≥ 前日 × MIN_BLACK_K_VOL_RATIO
    const volRatio = cd.volume / prev.volume;
    if (volRatio < MIN_BLACK_K_VOL_RATIO) continue;

    // 跌破前一日 K 低 OR 跌破 MA5
    const breakPrevLow = cd.close < prev.low;
    const breakMA5 = cd.ma5 != null && cd.close < cd.ma5;
    if (!breakPrevLow && !breakMA5) continue;

    // 取最近一根（迴圈是由近往遠，找到就 break）
    mostRecent = {
      index: i,
      high: cd.high,
      low: cd.low,
      date: cd.date,
      volumeRatio: volRatio,
    };
    break;
  }

  return mostRecent;
}

/**
 * 偵測位置 8 突破大量黑 K。
 */
export function detectBlackKBreakout(
  candles: CandleWithIndicators[],
  idx: number,
): BlackKBreakoutResult | null {
  if (idx < 21) return null;

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev || prev.volume <= 0 || c.open <= 0) return null;

  // 1. 必須在多頭趨勢中（書本「多頭上漲一波後」）
  if (detectTrend(candles, idx) !== '多頭') return null;

  // 2. 找最近 3 日內的大量黑 K
  const blackK = findRecentLargeVolumeBlackK(candles, idx);
  if (!blackK) return null;

  // 3. 今日紅 K
  if (c.close <= c.open) return null;

  // 4. 今日紅 K 實體 ≥ 2%
  const bodyPct = ((c.close - c.open) / c.open) * 100;
  if (bodyPct < 2.0) return null;

  // 5. 今日量比 ≥ 1.3
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < 1.3) return null;

  // 6. 今日收盤突破大量黑 K 最高點
  if (c.close <= blackK.high) return null;

  const daysSinceBlackK = idx - blackK.index;

  return {
    isBlackKBreakout: true,
    blackKHigh: blackK.high,
    blackKLow: blackK.low,
    blackKDate: blackK.date,
    blackKVolumeRatio: blackK.volumeRatio,
    bodyPct,
    volumeRatio,
    daysSinceBlackK,
    detail:
      `突破大量黑 K（${blackK.date} 大量黑 K 高 ${blackK.high.toFixed(1)} 量比×${blackK.volumeRatio.toFixed(2)}，` +
      `${daysSinceBlackK} 日後紅 K 突破：實體 ${bodyPct.toFixed(2)}%＋量×${volumeRatio.toFixed(2)}＋收盤 ${c.close.toFixed(1)}）`,
  };
}
