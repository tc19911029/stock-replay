/**
 * V 形反轉偵測（F 買法）— 書本精神簡化版
 *
 * 書本：朱家泓《K 線交易法》V 形反轉 + 寶典 Part 12 秘笈圖 #1 + Part 3 變盤線
 *
 * 結構：[連續下跌] → [變盤線止跌] → [止跌等待（不破變盤線低）] → [今日紅 K + 帶量 + 突破前 K 高]
 *
 * 條件（全部必滿足）：
 *   1. 連續下跌：變盤線之前 5 根下跌 ≥ 3 天 且 段首高 → 變盤線低 跌幅 ≥ 10%
 *   2. 變盤線：過去 1-15 根內出現變盤線（十字 / 紡錘 / 長下影），量能不限
 *   3. 不破變盤線低：變盤線後到今日前，最低不跌破變盤線 low
 *   4. 紅 K + 帶量：今日紅 K 且 量 ≥ 前 5 日均量 × 1.5
 *   5. 突破前 K 高：今日收盤 > 前一根 K 棒高點（含上影線）
 *
 * 不限大盤趨勢（V 形反轉本來就在空頭/弱勢中發生）。
 */

import type { CandleWithIndicators } from '@/types';

export type StopBarShape = '長下影' | '十字' | '紡錘';

export interface VReversalResult {
  isVReversal: boolean;
  /** 變盤線距今幾根前（1 ~ 15） */
  stopBarOffset: number;
  /** 變盤線型態 */
  stopBarShape: StopBarShape;
  /** 變盤線 low */
  stopBarLow: number;
  /** 變盤線之前 5 根下跌天數 */
  precedingDownDays: number;
  /** 段首高 → 變盤線低 的跌幅 % */
  precedingDrop: number;
  /** 今日量 / 前 5 日均量 */
  volumeRatio: number;
  /** 今日紅 K 實體 % */
  bodyPct: number;
  /** 前一根 K 高（突破參考） */
  prevHigh: number;
  detail: string;
}

const LOOKBACK_STOP_BAR = 15; // 變盤線搜尋距離（允許止跌等待多天）
const PRE_DROP_WINDOW = 6;    // 變盤線之前的下跌段觀察窗（含變盤線當天）
const MIN_DOWN_DAYS = 3;       // 連跌天數門檻
const MIN_DROP_PCT = 8;       // 跌幅門檻 %（段首高 → 變盤線低）
const VOLUME_MULT = 1.4;      // 今日帶量門檻

/** 判斷 K 棒是否為變盤線（十字 / 紡錘 / 長下影） */
function classifyReversalShape(c: CandleWithIndicators): StopBarShape | null {
  if (c.open <= 0) return null;
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range <= 0) return null;
  const lowerShadow = Math.min(c.open, c.close) - c.low;
  const bodyPct = body / c.open;

  if (bodyPct < 0.005) return '十字';
  if (body > 0 && lowerShadow > body * 2 && lowerShadow / range > 0.5) return '長下影';
  if (body / range < 0.3) return '紡錘';
  return null;
}

export function detectVReversal(
  candles: CandleWithIndicators[],
  idx: number,
): VReversalResult | null {
  if (idx < LOOKBACK_STOP_BAR + PRE_DROP_WINDOW) return null;
  const today = candles[idx];
  const prev = candles[idx - 1];
  if (!today || !prev || today.open <= 0) return null;

  // ── 進場 K 條件（今日）：紅 K + 帶量 + 收盤 > 前 K 高（含上影線） ──
  if (today.close <= today.open) return null;
  const bodyPct = ((today.close - today.open) / today.open) * 100;
  if (today.close <= prev.high) return null;

  const vol5seg = candles.slice(idx - 5, idx).map(c => c.volume).filter(v => v > 0);
  if (vol5seg.length < 3) return null;
  const avgVol5 = vol5seg.reduce((a, b) => a + b, 0) / vol5seg.length;
  if (avgVol5 <= 0) return null;
  const volumeRatio = today.volume / avgVol5;
  if (volumeRatio < VOLUME_MULT) return null;

  // ── 往前搜尋變盤線（1 ~ 15 根前）──
  for (let k = 1; k <= LOOKBACK_STOP_BAR; k++) {
    const sb = candles[idx - k];
    if (!sb) continue;

    const shape = classifyReversalShape(sb);
    if (!shape) continue;

    // (a) 連續下跌：變盤線含當天近 N 天下跌 ≥ 3 天 且 段高 → 變盤線低 跌幅 ≥ 門檻
    //    preSeg 從 stop bar 往前延伸（含 stop bar），才能正確抓到「變盤線之前高點」
    const preSeg = candles.slice(idx - k - PRE_DROP_WINDOW + 1, idx - k + 1);
    if (preSeg.length < PRE_DROP_WINDOW) continue;
    let downDays = 0;
    for (let i = 1; i < preSeg.length; i++) {
      if (preSeg[i].close < preSeg[i - 1].close) downDays++;
    }
    if (downDays < MIN_DOWN_DAYS) continue;
    // segHigh 取 stop bar 之前整個 window 的最高點（不只是 preSeg 的 high）
    const segHigh = Math.max(...preSeg.map(c => c.high));
    if (segHigh <= 0 || sb.low <= 0) continue;
    const drop = ((segHigh - sb.low) / segHigh) * 100;
    if (drop < MIN_DROP_PCT) continue;

    // (b) 止跌等待：變盤線後到今日前 low 不跌破變盤線 low（k=1 時此段為空，自動通過）
    let brokeLow = false;
    for (let i = idx - k + 1; i < idx; i++) {
      if (candles[i].low < sb.low) {
        brokeLow = true;
        break;
      }
    }
    if (brokeLow) continue;

    return {
      isVReversal: true,
      stopBarOffset: k,
      stopBarShape: shape,
      stopBarLow: sb.low,
      precedingDownDays: downDays,
      precedingDrop: drop,
      volumeRatio,
      bodyPct,
      prevHigh: prev.high,
      detail:
        `V 形反轉（${k} 根前${shape}止跌、之前${downDays}/${PRE_DROP_WINDOW}天跌${drop.toFixed(1)}%、` +
        `止跌${k - 1}天未破低 ${sb.low.toFixed(2)}、` +
        `今日紅K +${bodyPct.toFixed(1)}% 量×${volumeRatio.toFixed(2)} ` +
        `突破前K高 ${prev.high.toFixed(2)}）`,
    };
  }

  return null;
}
