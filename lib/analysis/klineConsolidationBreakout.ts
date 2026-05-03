/**
 * 策略 I：K 線橫盤突破進場偵測
 *
 * 朱家泓《活用技術分析寶典》Part 11-1 8 種進場位置「位置 3：等 K 線橫盤突破」（p.694）：
 *   多頭中長紅 K 上漲後，股價維持在這根紅 K 上方「橫盤整理」，
 *   隨後再大量中長紅 K 突破橫盤最高點，做多。
 *
 * 對應寶典 Part 12-4「18 種空轉多祕笈圖」第 5 圖「K 線橫盤突破」（p.802）。
 *
 * 用戶 Step 2 第 4 條「K 線橫盤突破」直接源頭。
 *
 * 與位置 1（盤整突破 C）的差異：
 *   位置 1：一段較長盤整（detectTrend === '盤整'）→ 突破上頸線
 *   位置 3：短期狹幅橫盤（5-15 天，在中長紅 K 上方）→ 突破橫盤最高點
 *
 * 條件：
 *   1. 多頭趨勢中
 *   2. 過去 5-15 根 K 線中，可找到一根「中長紅 K」當錨點：
 *      - 紅 K 實體 ≥ 3%（書本「中長紅」定義）
 *   3. 從錨點次日起到昨日，股價維持在錨點之上「橫盤」：
 *      - 期間最低 ≥ 錨點低點（不破錨點）
 *      - 期間最高與錨點高的距離 < 5%（狹幅整理）
 *      - 至少 4 根 K（5 天起算）
 *   4. 今日紅 K 實體 ≥ 2%（寶典 2024）
 *   5. 今日量 ≥ 前日 × 1.3
 *   6. 今日收盤突破橫盤期間最高點
 *
 * 不套戒律（strategyType='kline-pattern'）。
 */

import type { CandleWithIndicators } from '@/types';
import { detectTrend } from '@/lib/analysis/trendAnalysis';

export interface KlineConsolidationBreakoutResult {
  isBreakout: boolean;
  anchorDate: string;          // 中長紅 K 錨點日期
  anchorHigh: number;          // 錨點 K 最高
  anchorLow: number;           // 錨點 K 最低（停損參考）
  anchorBodyPct: number;       // 錨點實體 %
  rangeHigh: number;           // 橫盤期間最高（被突破的目標）
  rangeLow: number;            // 橫盤期間最低
  rangeWidthPct: number;       // 橫盤幅度（rangeHigh / anchorHigh - 1）
  consolidationDays: number;   // 橫盤天數（含錨點次日至昨日）
  bodyPct: number;             // 今日紅 K 實體
  volumeRatio: number;         // 今日量比
  detail: string;
}

const MIN_CONSOL_DAYS = 4;       // 至少 4 根橫盤 K（含今日突破共 ≥ 5 天）
const MAX_CONSOL_DAYS = 15;      // 最多 15 根（更久就接近位置 1 盤整突破）
const MIN_ANCHOR_BODY_PCT = 3;   // 中長紅 K：實體 ≥ 3%（寶典 Part 4-1「長紅」）
const MAX_RANGE_WIDTH_PCT = 5;   // 橫盤狹幅：高低差 / 錨點高 < 5%

interface AnchorCandidate {
  index: number;
  high: number;
  low: number;
  date: string;
  bodyPct: number;
}

/**
 * 在 [idx-MAX_CONSOL_DAYS-1, idx-MIN_CONSOL_DAYS-1] 區間內搜尋「中長紅 K 錨點」：
 *   錨點之後到昨日（idx-1）必須形成狹幅橫盤。
 *
 * 回傳第一個（最近的）符合條件的錨點。
 */
function findAnchorAndRange(
  candles: CandleWithIndicators[],
  idx: number,
): {
  anchor: AnchorCandidate;
  rangeHigh: number;
  rangeLow: number;
  rangeWidthPct: number;
  consolidationDays: number;
} | null {
  // 從近往遠找，錨點最近不能晚於 idx-MIN_CONSOL_DAYS-1
  // 例：MIN=4 → 錨點最近 idx-5（之後 idx-4..idx-1 共 4 根橫盤 + idx 突破）
  const newest = idx - MIN_CONSOL_DAYS - 1;
  const oldest = Math.max(0, idx - MAX_CONSOL_DAYS - 1);

  for (let anchorIdx = newest; anchorIdx >= oldest; anchorIdx--) {
    const a = candles[anchorIdx];
    if (!a || a.open <= 0) continue;

    // 必須是中長紅 K
    if (a.close <= a.open) continue;
    const anchorBodyPct = ((a.close - a.open) / a.open) * 100;
    if (anchorBodyPct < MIN_ANCHOR_BODY_PCT) continue;

    // 檢查 anchorIdx+1 .. idx-1 的橫盤：
    //   每根 low >= anchorLow（不破錨點低點）
    //   range 最高 - anchor 高的相對距離 < MAX_RANGE_WIDTH_PCT
    let rangeHigh = a.high;
    let rangeLow = a.low;
    let valid = true;

    for (let i = anchorIdx + 1; i < idx; i++) {
      const k = candles[i];
      if (!k) { valid = false; break; }
      // 不可跌破錨點低點
      if (k.low < a.low) { valid = false; break; }
      if (k.high > rangeHigh) rangeHigh = k.high;
      if (k.low < rangeLow) rangeLow = k.low;
    }

    if (!valid) continue;

    // 狹幅整理：rangeHigh 相對 anchorHigh 不可超過 MAX_RANGE_WIDTH_PCT
    const rangeWidthPct = ((rangeHigh - a.high) / a.high) * 100;
    if (rangeWidthPct > MAX_RANGE_WIDTH_PCT) continue;
    if (rangeWidthPct < 0) continue; // 整理期間連錨點高都沒摸到 → 不算橫盤

    const consolidationDays = idx - anchorIdx - 1;

    return {
      anchor: {
        index: anchorIdx,
        high: a.high,
        low: a.low,
        date: a.date,
        bodyPct: anchorBodyPct,
      },
      rangeHigh,
      rangeLow,
      rangeWidthPct,
      consolidationDays,
    };
  }

  return null;
}

/**
 * 偵測位置 3 K 線橫盤突破。
 */
export function detectKlineConsolidationBreakout(
  candles: CandleWithIndicators[],
  idx: number,
): KlineConsolidationBreakoutResult | null {
  if (idx < MAX_CONSOL_DAYS + 2) return null;

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev || prev.volume <= 0 || c.open <= 0) return null;

  // 1. 多頭趨勢
  if (detectTrend(candles, idx) !== '多頭') return null;

  // 2. 找錨點 + 橫盤區間
  const found = findAnchorAndRange(candles, idx);
  if (!found) return null;

  // 3. 今日紅 K
  if (c.close <= c.open) return null;

  // 4. 今日紅 K 實體 ≥ 2%
  const bodyPct = ((c.close - c.open) / c.open) * 100;
  if (bodyPct < 2.0) return null;

  // 5. 量比 ≥ 1.3
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < 1.3) return null;

  // 6. 收盤突破橫盤期間最高點
  if (c.close <= found.rangeHigh) return null;

  return {
    isBreakout: true,
    anchorDate: found.anchor.date,
    anchorHigh: found.anchor.high,
    anchorLow: found.anchor.low,
    anchorBodyPct: found.anchor.bodyPct,
    rangeHigh: found.rangeHigh,
    rangeLow: found.rangeLow,
    rangeWidthPct: found.rangeWidthPct,
    consolidationDays: found.consolidationDays,
    bodyPct,
    volumeRatio,
    detail:
      `K 線橫盤突破（${found.anchor.date} 中長紅 K 高 ${found.anchor.high.toFixed(2)} 實體 ${found.anchor.bodyPct.toFixed(2)}%，` +
      `${found.consolidationDays} 天橫盤幅度 ${found.rangeWidthPct.toFixed(2)}%，` +
      `今日突破 ${found.rangeHigh.toFixed(2)}：實體 ${bodyPct.toFixed(2)}%＋量×${volumeRatio.toFixed(2)}）`,
  };
}
