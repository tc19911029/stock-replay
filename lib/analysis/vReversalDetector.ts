/**
 * V 形反轉偵測（C 買法）
 *
 * 寶典 Part 12 祕笈圖 #1「低檔大量長紅 K 反轉」+
 * 《5步驟》位置 6「反轉向上：底部出現轉折 K 線組合確認」+
 * 飆股書 p.316「V 形底」
 *
 * 條件：
 * 1. 前 10 根至少 3 根黑 K（連跌段）
 * 2. 當日量 ≥ 前 5 日均量 × 2（爆量，對齊朱家泓「低檔大量長紅反轉」= 爆量 context）
 * 3. 當日紅 K 實體 ≥ 2%
 * 4. 當日收盤突破前日最高
 *
 * 不限大盤趨勢（底部反轉本來就在空頭/弱勢中發生）。
 * Phase 4（2026-04-20 並列買法架構）
 */

import type { CandleWithIndicators } from '@/types';

export interface VReversalResult {
  isVReversal: boolean;
  precedingBlackKCount: number;  // 前 10 根內黑 K 數
  precedingDrop: number;          // 前段跌幅 %
  bodyPct: number;
  volumeRatio5d: number;          // 相對前 5 日均量
  detail: string;
}

export function detectVReversal(
  candles: CandleWithIndicators[],
  idx: number,
): VReversalResult | null {
  if (idx < 11) return null;
  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev || c.open <= 0 || prev.high <= 0) return null;

  // 條件 3：當日紅 K 實體 ≥ 2%
  if (c.close <= c.open) return null;
  const bodyPct = (c.close - c.open) / c.open * 100;
  if (bodyPct < 2.0) return null;

  // 條件 4：收盤突破前日最高
  if (c.close <= prev.high) return null;

  // 條件 1：前 10 根內至少 3 根黑 K
  const lookback = 10;
  const segment = candles.slice(idx - lookback, idx); // 不含當日
  let blackKCount = 0;
  for (const k of segment) {
    if (k.close < k.open) blackKCount++;
  }
  if (blackKCount < 3) return null;

  // 前段跌幅（segment 起點到當日前收）
  const startClose = segment[0].close;
  const precedingDrop = startClose > 0 ? (startClose - prev.close) / startClose * 100 : 0;

  // 條件 2：當日量 ≥ 前 5 日均量 × 2（爆量，對齊朱家泓低檔大量長紅定義）
  const prev5 = candles.slice(idx - 5, idx);
  const volumes = prev5.map(k => k.volume).filter(v => v > 0);
  if (volumes.length < 3) return null;
  const avgVol5 = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  if (avgVol5 <= 0) return null;
  const volumeRatio5d = c.volume / avgVol5;
  if (volumeRatio5d < 2) return null;

  return {
    isVReversal: true,
    precedingBlackKCount: blackKCount,
    precedingDrop,
    bodyPct,
    volumeRatio5d,
    detail: `V 形反轉（前 ${lookback} 根 ${blackKCount} 黑 K、跌幅${precedingDrop.toFixed(1)}% → 當日實體+${bodyPct.toFixed(2)}%、量×${volumeRatio5d.toFixed(2)} 5日均量）`,
  };
}
