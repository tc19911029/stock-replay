/**
 * Breakthrough Quality Assessment (突破品質評估)
 *
 * Evaluates HOW a stock is approaching or breaking through a resistance zone.
 * Based on Gemini/technical analysis insights:
 *
 * 1. Approach Pattern — N-wave (進二退一) is healthier than V-rush
 * 2. Candle Quality — Solid long red closing near high = strong commitment
 * 3. Volume Profile — Moderate 2x volume is ideal; 天量 is risky
 * 4. Retest Status — Post-breakout pullback to old resistance = strongest signal
 * 5. S/R Flip — Former resistance now acting as support
 */

import { CandleWithIndicators } from '@/types';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BreakthroughQualityResult {
  /** Composite score adjustment: -10 to +15 */
  compositeAdjust: number;
  /** Overall quality score 0-100 */
  totalScore: number;
  /** Letter grade */
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  /** Whether N-wave attack pattern detected */
  nWaveDetected: boolean;
  /** Whether post-breakout retest confirmed */
  retestConfirmed: boolean;
  /** Whether support/resistance flip detected */
  srFlipDetected: boolean;
  /** Breakdown of sub-scores */
  components: {
    approachPattern: number;
    candleQuality: number;
    volumeProfile: number;
    retestStatus: number;
    srFlip: number;
  };
  detail: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function toGrade(score: number): BreakthroughQualityResult['grade'] {
  if (score >= 80) return 'S';
  if (score >= 65) return 'A';
  if (score >= 50) return 'B';
  if (score >= 35) return 'C';
  return 'D';
}

/**
 * Find swing highs in a candle array (simple 3-bar comparison).
 * Returns array of { idx, price } sorted by index.
 */
function findSwingHighs(
  candles: CandleWithIndicators[],
  startIdx: number,
  endIdx: number,
): Array<{ idx: number; price: number }> {
  const pivots: Array<{ idx: number; price: number }> = [];
  for (let i = startIdx + 1; i < endIdx; i++) {
    if (i < 1 || i >= candles.length - 1) continue;
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];
    if (curr.high > prev.high && curr.high > next.high) {
      pivots.push({ idx: i, price: curr.high });
    }
  }
  return pivots;
}

/**
 * Find swing lows in a candle array (simple 3-bar comparison).
 */
function findSwingLows(
  candles: CandleWithIndicators[],
  startIdx: number,
  endIdx: number,
): Array<{ idx: number; price: number }> {
  const pivots: Array<{ idx: number; price: number }> = [];
  for (let i = startIdx + 1; i < endIdx; i++) {
    if (i < 1 || i >= candles.length - 1) continue;
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];
    if (curr.low < prev.low && curr.low < next.low) {
      pivots.push({ idx: i, price: curr.low });
    }
  }
  return pivots;
}

// ── Sub-Scoring Functions ────────────────────────────────────────────────────

const WEIGHTS = {
  approachPattern: 0.25,
  candleQuality: 0.20,
  volumeProfile: 0.15,
  retestStatus: 0.25,
  srFlip: 0.15,
};

/**
 * 1. Approach Pattern: N-wave vs V-rush
 *
 * Ideal pattern: price approaches resistance → pulls back on low volume →
 * re-advances on higher volume = N-wave (進二退一).
 * V-shaped rush (straight up with no pullback) = high failure rate.
 */
function scoreApproachPattern(
  candles: CandleWithIndicators[],
  idx: number,
): { score: number; nWaveDetected: boolean; detail: string } {
  if (idx < 20) return { score: 50, nWaveDetected: false, detail: '資料不足' };

  const lookback = Math.min(idx, 30);
  const startIdx = idx - lookback;

  const swingHighs = findSwingHighs(candles, startIdx, idx);
  const swingLows = findSwingLows(candles, startIdx, idx);

  if (swingHighs.length < 1 || swingLows.length < 1) {
    return { score: 50, nWaveDetected: false, detail: '無明顯波段結構' };
  }

  // Look for N-wave: a swing high → pullback (swing low) → current advance
  // The pullback should retrace 30-65% and have lower volume
  const price = candles[idx].close;
  let nWaveDetected = false;
  let bestScore = 50; // neutral default

  for (let h = swingHighs.length - 1; h >= 0; h--) {
    const high = swingHighs[h];
    // Find a swing low AFTER this high
    const pullbackLow = swingLows.find(l => l.idx > high.idx);
    if (!pullbackLow) continue;

    // The current price should be above the pullback low
    if (price <= pullbackLow.price) continue;

    // Calculate retracement depth
    const advance = high.price - (candles[startIdx]?.low ?? pullbackLow.price);
    if (advance <= 0) continue;
    const retracement = (high.price - pullbackLow.price) / advance;

    // Ideal: 30-65% retracement
    const retracementScore = retracement >= 0.30 && retracement <= 0.65
      ? 80
      : retracement >= 0.20 && retracement <= 0.75
        ? 60
        : 30;

    // Volume should decrease during pullback
    let pullbackVolDecline = false;
    if (pullbackLow.idx > high.idx && pullbackLow.idx <= idx) {
      const highVol = candles[high.idx].volume;
      const lowVol = candles[pullbackLow.idx].volume;
      pullbackVolDecline = lowVol < highVol * 0.7;
    }

    // Current candle should have rising volume vs pullback
    const currentVol = candles[idx].volume;
    const pullbackVol = candles[pullbackLow.idx].volume;
    const volRebound = currentVol > pullbackVol * 1.3;

    const volScore = (pullbackVolDecline ? 30 : 0) + (volRebound ? 30 : 0);
    const candidateScore = clamp(retracementScore * 0.5 + volScore * 0.5, 0, 100);

    if (candidateScore > bestScore) {
      bestScore = candidateScore;
      nWaveDetected = retracementScore >= 60 && (pullbackVolDecline || volRebound);
    }

    break; // Use the most recent pattern
  }

  // Penalise V-rush: 5+ consecutive red candles approaching current level
  let consecutiveRedCount = 0;
  for (let i = idx; i > idx - 8 && i >= 0; i--) {
    if (candles[i].close > candles[i].open) {
      consecutiveRedCount++;
    } else {
      break;
    }
  }
  // 連漲懲罰加重：4 根以上紅 K = 高疲竭風險
  if (consecutiveRedCount >= 5) {
    bestScore = clamp(bestScore - 35, 0, 100);
  } else if (consecutiveRedCount >= 4) {
    bestScore = clamp(bestScore - 20, 0, 100);
  }

  // 5 日累計漲幅過大懲罰
  if (idx >= 5) {
    const bar5Ago = candles[idx - 5];
    if (bar5Ago && bar5Ago.close > 0) {
      const gain5d = ((candles[idx].close - bar5Ago.close) / bar5Ago.close) * 100;
      if (gain5d > 12) {
        bestScore = clamp(bestScore - 15, 0, 100);
      }
    }
  }

  const detail = nWaveDetected
    ? `N字型攻擊（進二退一，回檔量縮）`
    : consecutiveRedCount >= 4
      ? `V型硬闖（連${consecutiveRedCount}紅無回檔）`
      : '一般攻擊節奏';

  return { score: Math.round(bestScore), nWaveDetected, detail };
}

/**
 * 2. Candle Quality: How strong is today's candle?
 *
 * Best: solid long red body, closing near high, minimal upper shadow.
 * Worst: long upper shadow (rejection), closing near low.
 */
function scoreCandleQuality(
  candles: CandleWithIndicators[],
  idx: number,
): { score: number; detail: string } {
  const c = candles[idx];
  const body = c.close - c.open; // positive = red (bullish)
  const range = c.high - c.low;

  if (range <= 0) return { score: 50, detail: '無波動' };

  let score = 50;
  const details: string[] = [];

  // Body ratio: how much of the range is body
  const bodyRatio = Math.abs(body) / range;

  // Is it bullish?
  if (body > 0) {
    // Bullish candle
    // Body size relative to price
    const bodyPct = body / c.open * 100;

    // Close near high ratio
    const closeNearHigh = (c.close - c.low) / range;

    // Upper shadow ratio (small = better)
    const upperShadowRatio = (c.high - c.close) / range;

    // Score body strength
    if (bodyPct >= 3) score += 20;
    else if (bodyPct >= 2) score += 15;
    else if (bodyPct >= 1) score += 5;

    // Score body ratio (solid body vs shadows)
    if (bodyRatio >= 0.7) score += 15;
    else if (bodyRatio >= 0.5) score += 10;

    // Score close near high
    if (closeNearHigh >= 0.85) {
      score += 15;
      details.push('收最高附近');
    } else if (closeNearHigh >= 0.7) {
      score += 8;
    }

    // Penalise long upper shadow (rejection)
    if (upperShadowRatio >= 0.3) {
      score -= 20;
      details.push(`上影線過長(${(upperShadowRatio * 100).toFixed(0)}%)`);
    } else if (upperShadowRatio >= 0.2) {
      score -= 10;
    }
  } else {
    // Bearish candle — generally poor for breakthrough
    score -= 15;
    details.push('收黑K');
  }

  return {
    score: clamp(Math.round(score), 0, 100),
    detail: details.join('，') || (body > 0 ? '紅K表態' : '黑K觀望'),
  };
}

/**
 * 3. Volume Profile: Is volume "just right"?
 *
 * Ideal: 1.5-3x average (moderate conviction).
 * Too low (<1.3x): no conviction, breakout likely fails.
 * Too high (>5x): exhaustion risk (天量見高點).
 */
function scoreVolumeProfile(
  candles: CandleWithIndicators[],
  idx: number,
): { score: number; detail: string } {
  const c = candles[idx];
  const avgVol = c.avgVol5 ?? 0;
  if (avgVol <= 0) return { score: 50, detail: '無均量資料' };

  const volRatio = c.volume / avgVol;
  let score: number;
  let detail: string;

  if (volRatio >= 5.0) {
    // Explosive volume — 天量 warning
    score = 30;
    detail = `爆量天量(${volRatio.toFixed(1)}x)，小心見高點`;
  } else if (volRatio >= 3.0) {
    // High but acceptable
    score = 60;
    detail = `大量(${volRatio.toFixed(1)}x)，留意後續量能`;
  } else if (volRatio >= 1.8) {
    // Ideal moderate volume
    score = 90;
    detail = `溫和放量(${volRatio.toFixed(1)}x)，理想攻擊量`;
  } else if (volRatio >= 1.3) {
    // Acceptable
    score = 70;
    detail = `小幅放量(${volRatio.toFixed(1)}x)`;
  } else {
    // Insufficient volume
    score = 25;
    detail = `量能不足(${volRatio.toFixed(1)}x)，突破信心弱`;
  }

  // Bonus: 3-day volume buildup (gradually increasing)
  if (idx >= 2) {
    const v0 = candles[idx - 2].volume;
    const v1 = candles[idx - 1].volume;
    const v2 = c.volume;
    if (v2 > v1 && v1 > v0 && v2 > avgVol) {
      score = clamp(score + 10, 0, 100);
      detail += '，連3日量增';
    }
  }

  return { score: clamp(score, 0, 100), detail };
}

/**
 * 4. Retest Status: Has the stock pulled back to test and held?
 *
 * Look back 3-15 candles for a pattern:
 * - Prior breakout above a swing high
 * - Pullback toward that level (within 2% of old resistance)
 * - Volume shrinks during pullback
 * - Price holds above the level → confirmed retest
 *
 * This is the STRONGEST confirmation of a real breakout.
 */
function scoreRetestStatus(
  candles: CandleWithIndicators[],
  idx: number,
): { score: number; retestConfirmed: boolean; detail: string } {
  if (idx < 15) return { score: 50, retestConfirmed: false, detail: '資料不足' };

  const price = candles[idx].close;
  const lookback = Math.min(idx, 40);
  const startIdx = idx - lookback;

  // Find swing highs that could serve as breakout levels
  const swingHighs = findSwingHighs(candles, startIdx, idx - 3);

  let retestConfirmed = false;
  let bestScore = 50;

  for (const sh of swingHighs.reverse()) {
    // Check: was there a breakout above this level?
    let brokeAbove = false;
    let breakIdx = -1;
    for (let i = sh.idx + 1; i <= idx; i++) {
      if (candles[i].close > sh.price * 1.01) {
        brokeAbove = true;
        breakIdx = i;
        break;
      }
    }
    if (!brokeAbove || breakIdx < 0) continue;

    // Check: did price pull back toward the level after breaking?
    let pullbackFound = false;
    let pullbackHeld = false;
    let pullbackVolShrunk = false;

    for (let i = breakIdx + 1; i <= idx; i++) {
      const c = candles[i];
      const distToLevel = (c.low - sh.price) / sh.price;

      // Pullback: price comes within 2% above the old resistance
      if (distToLevel >= -0.02 && distToLevel <= 0.03) {
        pullbackFound = true;

        // Did it hold? (close above the level)
        if (c.close >= sh.price * 0.98) {
          pullbackHeld = true;
        }

        // Volume during pullback should be lower than breakout candle
        const breakVol = candles[breakIdx].volume;
        if (c.volume < breakVol * 0.7) {
          pullbackVolShrunk = true;
        }
      }
    }

    if (pullbackFound && pullbackHeld) {
      retestConfirmed = true;
      bestScore = 85;
      if (pullbackVolShrunk) bestScore = 95;
      break;
    } else if (pullbackFound && !pullbackHeld) {
      // Failed retest — bearish
      bestScore = 15;
      break;
    } else if (brokeAbove && !pullbackFound) {
      // Breakout but no retest yet — neutral/slightly positive
      bestScore = 55;
    }
  }

  const detail = retestConfirmed
    ? '回測確認（壓力轉支撐，量縮守穩）'
    : bestScore <= 20
      ? '回測失敗（跌破舊壓力）'
      : bestScore > 50
        ? '已突破，尚未回測'
        : '無明顯突破回測';

  return { score: clamp(bestScore, 0, 100), retestConfirmed, detail };
}

/**
 * 5. S/R Flip: Has old resistance become new support?
 *
 * Detect: price broke above a level, pulled back to it, and bounced UP.
 * The bounce candle should be bullish with adequate volume.
 */
function scoreSRFlip(
  candles: CandleWithIndicators[],
  idx: number,
): { score: number; srFlipDetected: boolean; detail: string } {
  if (idx < 15) return { score: 50, srFlipDetected: false, detail: '資料不足' };

  const price = candles[idx].close;
  const lookback = Math.min(idx, 40);
  const startIdx = idx - lookback;

  const swingHighs = findSwingHighs(candles, startIdx, idx - 5);
  let srFlipDetected = false;
  let bestScore = 50;

  for (const sh of swingHighs.reverse()) {
    // Price must currently be above this old resistance
    if (price <= sh.price) continue;

    // Check: was there a touch-from-above after breakout?
    let touchFromAbove = false;
    let bounced = false;

    for (let i = sh.idx + 3; i <= idx - 1; i++) {
      const c = candles[i];
      // Touch: low comes near the old high (within 1.5%)
      if (c.low <= sh.price * 1.015 && c.low >= sh.price * 0.985) {
        touchFromAbove = true;
        // Did it bounce? Next candle should be bullish
        if (i + 1 <= idx) {
          const next = candles[i + 1];
          if (next.close > next.open && next.close > c.close) {
            bounced = true;
          }
        }
      }
    }

    if (touchFromAbove && bounced) {
      srFlipDetected = true;
      bestScore = 90;
      break;
    } else if (touchFromAbove) {
      bestScore = 65;
    }
  }

  const detail = srFlipDetected
    ? '壓力轉支撐確認（從上方彈開）'
    : bestScore > 55
      ? '曾觸及舊壓力，但反彈力道不明'
      : '無壓力轉支撐訊號';

  return { score: clamp(bestScore, 0, 100), srFlipDetected, detail };
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Assess the quality of a stock's approach to / breakthrough of resistance.
 *
 * @param candles  Full candle array with indicators
 * @param idx      Index of the "current" candle to evaluate
 */
export function analyzeBreakthroughQuality(
  candles: CandleWithIndicators[],
  idx: number,
): BreakthroughQualityResult {
  const neutral: BreakthroughQualityResult = {
    compositeAdjust: 0,
    totalScore: 50,
    grade: 'C',
    nWaveDetected: false,
    retestConfirmed: false,
    srFlipDetected: false,
    components: {
      approachPattern: 50,
      candleQuality: 50,
      volumeProfile: 50,
      retestStatus: 50,
      srFlip: 50,
    },
    detail: 'insufficient data',
  };

  if (idx < 20) return neutral;

  // Compute all sub-scores
  const approach = scoreApproachPattern(candles, idx);
  const candle = scoreCandleQuality(candles, idx);
  const volume = scoreVolumeProfile(candles, idx);
  const retest = scoreRetestStatus(candles, idx);
  const srFlip = scoreSRFlip(candles, idx);

  // Weighted total
  const totalScore = Math.round(
    approach.score * WEIGHTS.approachPattern +
    candle.score * WEIGHTS.candleQuality +
    volume.score * WEIGHTS.volumeProfile +
    retest.score * WEIGHTS.retestStatus +
    srFlip.score * WEIGHTS.srFlip,
  );

  // Composite adjustment
  let compositeAdjust: number;
  if (totalScore >= 80) {
    compositeAdjust = 10 + Math.round((totalScore - 80) / 4); // +10 to +15
  } else if (totalScore >= 50) {
    compositeAdjust = Math.round((totalScore - 50) / 4); // +0 to +8
  } else if (totalScore >= 30) {
    compositeAdjust = 0;
  } else {
    compositeAdjust = -Math.round((30 - totalScore) / 3); // -1 to -10
  }

  const details = [approach.detail, candle.detail, volume.detail, retest.detail, srFlip.detail]
    .filter(Boolean)
    .join('；');

  return {
    compositeAdjust: clamp(compositeAdjust, -10, 15),
    totalScore: clamp(totalScore, 0, 100),
    grade: toGrade(totalScore),
    nWaveDetected: approach.nWaveDetected,
    retestConfirmed: retest.retestConfirmed,
    srFlipDetected: srFlip.srFlipDetected,
    components: {
      approachPattern: approach.score,
      candleQuality: candle.score,
      volumeProfile: volume.score,
      retestStatus: retest.score,
      srFlip: srFlip.score,
    },
    detail: details,
  };
}
