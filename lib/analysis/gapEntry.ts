/**
 * 策略 D：缺口進場偵測（跳空上漲）
 *
 * 2026-04-20 命名重整：原「E 買法」改為「策略 D」。
 *
 * 朱家泓《做對5個實戰步驟》p.40 做多位置 4「跳空上漲」：
 *   向上跳空缺口的大量長紅 K
 *
 * 書本條件：
 * 1. 開盤 > 前日最高（向上跳空）
 * 2. 量 ≥ 前日 × 1.3（共通進場量標準）
 * 3. 紅 K 實體 ≥ 2.5%
 * 4. 收紅 K（close > open）
 *
 * 不限大盤趨勢（像台積電 4/8 在空頭中跳空也算）。
 * 不套戒律（書本 Part 3 K 線型態買法）。
 */

import type { CandleWithIndicators } from '@/types';

export interface GapEntryResult {
  isGapEntry: boolean;
  gapPct: number;          // 跳空幅度 %（相對前日最高）
  bodyPct: number;         // 紅 K 實體 %
  volumeRatio: number;     // 相對前日量
  detail: string;
}

export function detectStrategyD(
  candles: CandleWithIndicators[],
  idx: number,
): GapEntryResult | null {
  if (idx < 1) return null;
  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev) return null;
  if (prev.high <= 0 || prev.volume <= 0 || c.open <= 0) return null;

  // 條件 1：向上跳空（開盤 > 前日最高）
  const gapPct = (c.open - prev.high) / prev.high * 100;
  if (gapPct <= 0) return null;

  // 條件 4：收紅 K
  if (c.close <= c.open) return null;

  // 條件 3：紅 K 實體 ≥ 2.5%
  const bodyPct = (c.close - c.open) / c.open * 100;
  if (bodyPct < 2.5) return null;

  // 條件 2：量比 ≥ 1.3
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < 1.3) return null;

  return {
    isGapEntry: true,
    gapPct,
    bodyPct,
    volumeRatio,
    detail: `跳空上漲（缺口+${gapPct.toFixed(2)}%、實體+${bodyPct.toFixed(2)}%、量比×${volumeRatio.toFixed(2)}）`,
  };
}

/** @deprecated 2026-04-20 改名為 detectStrategyD，本 alias 提供過渡期相容；下次清理時移除 */
export const detectGapEntry = detectStrategyD;
