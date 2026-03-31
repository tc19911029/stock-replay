/**
 * Smart Money Detection & Multi-Factor Composite Score
 *
 * Detects institutional/smart money activity using volume-price patterns
 * (no external data dependency - pure technical proxy).
 *
 * Research basis:
 * - Institutional accumulation: rising OBV + volume on up days > down days
 * - Smart money divergence: price consolidates but OBV trends up
 * - Revenue momentum proxy: gap-up patterns + sustained volume after breakout
 *
 * Scoring dimensions:
 * 1. Accumulation/Distribution (30%) - OBV trend + volume asymmetry
 * 2. Smart Money Flow (25%) - large-body candle volume vs small-body volume
 * 3. Buying Pressure (20%) - close position within day range + volume
 * 4. Institutional Footprint (15%) - gap patterns + controlled pullbacks
 * 5. Revenue Momentum Proxy (10%) - price acceleration at key dates
 */

import { CandleWithIndicators } from '@/types';

export interface SmartMoneyComponent {
  score: number; // 0-100
  detail: string;
}

export interface SmartMoneyResult {
  totalScore: number; // 0-100
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  components: {
    accumulation: SmartMoneyComponent;
    smartFlow: SmartMoneyComponent;
    buyingPressure: SmartMoneyComponent;
    institutionalFootprint: SmartMoneyComponent;
    revenueMomentumProxy: SmartMoneyComponent;
  };
}

const WEIGHTS = {
  accumulation: 0.30,
  smartFlow: 0.25,
  buyingPressure: 0.20,
  institutionalFootprint: 0.15,
  revenueMomentumProxy: 0.10,
};

function clamp(v: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, v));
}

function toGrade(score: number): SmartMoneyResult['grade'] {
  if (score >= 80) return 'S';
  if (score >= 65) return 'A';
  if (score >= 50) return 'B';
  if (score >= 35) return 'C';
  return 'D';
}

// ── 1. Accumulation/Distribution Score ──────────────────────────────────────

function scoreAccumulation(candles: CandleWithIndicators[], idx: number): SmartMoneyComponent {
  let score = 0;
  const details: string[] = [];
  const lookback = Math.min(idx, 20);
  if (lookback < 10) return { score: 50, detail: 'data insufficient' };

  // OBV trend: compute OBV over last 20 days, check if trending up
  let obv = 0;
  const obvArr: number[] = [];
  for (let i = idx - lookback; i <= idx; i++) {
    const c = candles[i];
    const prev = i > 0 ? candles[i - 1] : null;
    if (prev) {
      if (c.close > prev.close) obv += c.volume;
      else if (c.close < prev.close) obv -= c.volume;
    }
    obvArr.push(obv);
  }

  // OBV slope: compare first half average to second half average
  const midpoint = Math.floor(obvArr.length / 2);
  const firstHalf = obvArr.slice(0, midpoint);
  const secondHalf = obvArr.slice(midpoint);
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  if (avgSecond > avgFirst * 1.1) {
    score += 40;
    details.push('OBV uptrend');
  } else if (avgSecond > avgFirst) {
    score += 20;
    details.push('OBV slightly up');
  }

  // Volume asymmetry: total volume on up days vs down days
  let upVol = 0, downVol = 0;
  for (let i = idx - lookback + 1; i <= idx; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (c.close > prev.close) upVol += c.volume;
    else downVol += c.volume;
  }
  const volAsymmetry = downVol > 0 ? upVol / downVol : 2;
  if (volAsymmetry > 1.5) {
    score += 35;
    details.push(`up/down vol ${volAsymmetry.toFixed(1)}x`);
  } else if (volAsymmetry > 1.2) {
    score += 20;
    details.push('slight vol asymmetry');
  }

  // Recent 5 days OBV acceleration
  if (obvArr.length >= 6) {
    const recentOBV = obvArr[obvArr.length - 1] - obvArr[obvArr.length - 6];
    const priorOBV = obvArr.length >= 11 ? obvArr[obvArr.length - 6] - obvArr[obvArr.length - 11] : 0;
    if (recentOBV > priorOBV && recentOBV > 0) {
      score += 25;
      details.push('OBV accelerating');
    }
  }

  return { score: clamp(score), detail: details.join(', ') || 'neutral' };
}

// ── 2. Smart Money Flow Score ───────────────────────────────────────────────

function scoreSmartFlow(candles: CandleWithIndicators[], idx: number): SmartMoneyComponent {
  let score = 0;
  const details: string[] = [];
  const lookback = Math.min(idx, 20);
  if (lookback < 10) return { score: 50, detail: 'data insufficient' };

  // Concept: institutional traders create large-body candles with high volume
  // Retail creates small-body candles (indecision)
  // Smart money = volume weighted by body size

  let bigBodyVol = 0, smallBodyVol = 0;
  let bigBodyCount = 0, _smallBodyCount = 0;

  for (let i = idx - lookback + 1; i <= idx; i++) {
    const c = candles[i];
    const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
    if (bodyPct >= 0.015) { // "big" body >= 1.5%
      bigBodyVol += c.volume;
      bigBodyCount++;
    } else {
      smallBodyVol += c.volume;
      _smallBodyCount++;
    }
  }

  // Smart money ratio: big body volume / total volume
  const totalVol = bigBodyVol + smallBodyVol;
  if (totalVol > 0) {
    const smartRatio = bigBodyVol / totalVol;
    if (smartRatio > 0.7) { score += 40; details.push(`smart ratio ${(smartRatio * 100).toFixed(0)}%`); }
    else if (smartRatio > 0.5) { score += 25; details.push('moderate smart flow'); }
  }

  // Direction of big body candles: mostly bullish?
  let bullBigCount = 0;
  for (let i = idx - lookback + 1; i <= idx; i++) {
    const c = candles[i];
    const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
    if (bodyPct >= 0.015 && c.close > c.open) bullBigCount++;
  }
  if (bigBodyCount > 0) {
    const bullRatio = bullBigCount / bigBodyCount;
    if (bullRatio > 0.7) { score += 35; details.push('strong bull big-body'); }
    else if (bullRatio > 0.5) { score += 20; details.push('moderate bull big-body'); }
  }

  // Volume climax detection: today's volume is top 3 in 20 days AND bullish
  const volumes = [];
  for (let i = idx - lookback + 1; i <= idx; i++) volumes.push(candles[i].volume);
  const sortedVols = [...volumes].sort((a, b) => b - a);
  const c = candles[idx];
  if (c.volume >= sortedVols[2] && c.close > c.open) {
    score += 25;
    details.push('volume climax (bull)');
  }

  // ── 出貨量偵測：高量 + 收盤在下半段 = 機構出貨 ──────────────────────
  // 近 3 天放量但收盤位置偏低 → 扣分
  let distributionCount = 0;
  const avgVol = totalVol / lookback;
  for (let i = idx; i > idx - 3 && i >= idx - lookback + 1; i--) {
    const bar = candles[i];
    const range = bar.high - bar.low;
    const clv = range > 0 ? (bar.close - bar.low) / range : 0.5;
    if (bar.volume > avgVol * 1.5 && clv < 0.4) {
      distributionCount++;
    }
  }
  if (distributionCount >= 2) {
    score -= 30;
    details.push('distribution detected (高量收低)');
  } else if (distributionCount >= 1) {
    score -= 15;
    details.push('possible distribution');
  }

  // ── 量價背離：連 3 天放量但漲幅遞減 = 買盤衰竭 ────────────────────
  if (idx >= 3) {
    const bar0 = candles[idx], bar1 = candles[idx - 1], bar2 = candles[idx - 2];
    const gain0 = bar0.close > bar0.open ? (bar0.close - bar0.open) / bar0.open * 100 : 0;
    const gain1 = bar1.close > bar1.open ? (bar1.close - bar1.open) / bar1.open * 100 : 0;
    const gain2 = bar2.close > bar2.open ? (bar2.close - bar2.open) / bar2.open * 100 : 0;
    if (bar0.volume > avgVol * 1.3 && bar1.volume > avgVol * 1.3 && bar2.volume > avgVol * 1.3
      && gain0 < gain1 && gain1 < gain2 && gain2 > 0) {
      score -= 20;
      details.push('volume-price divergence (量增價減)');
    }
  }

  return { score: clamp(score), detail: details.join(', ') || 'neutral' };
}

// ── 3. Buying Pressure Score ────────────────────────────────────────────────

function scoreBuyingPressure(candles: CandleWithIndicators[], idx: number): SmartMoneyComponent {
  let score = 0;
  const details: string[] = [];
  const lookback = Math.min(idx, 10);
  if (lookback < 5) return { score: 50, detail: 'data insufficient' };

  // Close Location Value (CLV): (close - low) / (high - low)
  // Consistently high CLV = persistent buying pressure
  let clvSum = 0;
  let highClvDays = 0;
  for (let i = idx - lookback + 1; i <= idx; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    const clv = range > 0 ? (c.close - c.low) / range : 0.5;
    clvSum += clv;
    if (clv > 0.7) highClvDays++;
  }
  const avgCLV = clvSum / lookback;

  if (avgCLV > 0.7) { score += 40; details.push(`avg CLV ${(avgCLV * 100).toFixed(0)}%`); }
  else if (avgCLV > 0.55) { score += 20; details.push('moderate CLV'); }

  if (highClvDays >= lookback * 0.6) {
    score += 25;
    details.push(`${highClvDays}/${lookback} high-close days`);
  }

  // Buying tail ratio: lower shadow / total range (indicates buying on dips)
  let buyingTailSum = 0;
  for (let i = idx - 4; i <= idx; i++) {
    if (i < 0) continue;
    const c = candles[i];
    const range = c.high - c.low;
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    buyingTailSum += range > 0 ? lowerShadow / range : 0;
  }
  const avgBuyingTail = buyingTailSum / Math.min(5, idx + 1);
  if (avgBuyingTail > 0.25) {
    score += 20;
    details.push('strong buying tails');
  }

  // Today specifically: close near high with volume
  const today = candles[idx];
  const todayRange = today.high - today.low;
  const todayCLV = todayRange > 0 ? (today.close - today.low) / todayRange : 0.5;
  if (todayCLV > 0.8 && today.close > today.open) {
    score += 15;
    details.push('today strong close');
  }

  // ── A-share BB Squeeze Reversal Bonus ──────────────────────────────────
  // When Bollinger Bandwidth compresses (squeeze) and price breaks upper band,
  // it signals a strong breakout from low-volatility accumulation.
  if (today.bbBandwidth != null && today.bbUpper != null && today.bbLower != null) {
    // Check if bandwidth is in squeeze territory (below historical median)
    if (idx >= 20) {
      let bwSum = 0;
      let bwCount = 0;
      for (let i = idx - 19; i <= idx; i++) {
        if (candles[i].bbBandwidth != null) {
          bwSum += candles[i].bbBandwidth!;
          bwCount++;
        }
      }
      if (bwCount > 0) {
        const avgBW = bwSum / bwCount;
        const isSqueeze = today.bbBandwidth < avgBW * 0.8;
        const breaksUpper = today.close > today.bbUpper;
        if (isSqueeze && breaksUpper) {
          score += 15;
          details.push('BB squeeze breakout');
        }
      }
    }
  }

  return { score: clamp(score), detail: details.join(', ') || 'neutral' };
}

// ── 4. Institutional Footprint Score ────────────────────────────────────────

function scoreInstitutionalFootprint(candles: CandleWithIndicators[], idx: number): SmartMoneyComponent {
  let score = 0;
  const details: string[] = [];
  if (idx < 20) return { score: 50, detail: 'data insufficient' };

  // Gap-up patterns: institutional buying often creates gaps
  let gapUpCount = 0;
  for (let i = idx - 19; i <= idx; i++) {
    if (i <= 0) continue;
    const c = candles[i];
    const prev = candles[i - 1];
    if (c.open > prev.high) gapUpCount++; // True gap up
  }
  if (gapUpCount >= 3) { score += 30; details.push(`${gapUpCount} gap-ups in 20d`); }
  else if (gapUpCount >= 1) { score += 15; details.push(`${gapUpCount} gap-up`); }

  // Controlled pullbacks: during pullbacks, volume decreases (institutions holding)
  // Look for declining volume during price pullbacks in last 10 days
  let pullbackDays = 0;
  let lowVolPullbackDays = 0;
  for (let i = idx - 9; i <= idx; i++) {
    if (i <= 0) continue;
    const c = candles[i];
    const prev = candles[i - 1];
    if (c.close < prev.close) { // pullback day
      pullbackDays++;
      if (c.avgVol5 && c.volume < c.avgVol5 * 0.8) lowVolPullbackDays++; // low volume pullback
    }
  }
  if (pullbackDays > 0 && lowVolPullbackDays >= pullbackDays * 0.6) {
    score += 35;
    details.push('controlled low-vol pullbacks');
  } else if (pullbackDays > 0 && lowVolPullbackDays >= pullbackDays * 0.4) {
    score += 20;
    details.push('some controlled pullbacks');
  }

  // Narrow range days followed by expansion: accumulation then breakout
  let narrowCount = 0;
  for (let i = idx - 10; i < idx - 2; i++) {
    if (i < 0) continue;
    const c = candles[i];
    const range = c.high - c.low;
    const rangePct = c.low > 0 ? range / c.low : 0;
    if (rangePct < 0.02) narrowCount++; // < 2% daily range
  }
  const todayRange = candles[idx].high - candles[idx].low;
  const todayRangePct = candles[idx].low > 0 ? todayRange / candles[idx].low : 0;
  if (narrowCount >= 3 && todayRangePct > 0.03) {
    score += 25;
    details.push('accumulation→expansion');
  }

  // Support at key MA levels: price bouncing off MA20 with volume
  const c = candles[idx];
  if (c.ma20 && c.low <= c.ma20 * 1.02 && c.close > c.ma20 && c.close > c.open) {
    score += 10;
    details.push('MA20 support bounce');
  }

  return { score: clamp(score), detail: details.join(', ') || 'neutral' };
}

// ── 5. Revenue Momentum Proxy Score ─────────────────────────────────────────
// Since we don't have actual revenue data in real-time, we use price patterns
// that correlate with fundamental strength:
// - Sustained trend with rising MA60
// - Relative strength vs market
// - Price making new highs after consolidation (typical of revenue surprises)

function scoreRevenueMomentumProxy(candles: CandleWithIndicators[], idx: number): SmartMoneyComponent {
  let score = 0;
  const details: string[] = [];
  if (idx < 60) return { score: 50, detail: 'data insufficient' };

  const c = candles[idx];

  // 60-day price performance (strong fundamentals = sustained price gains)
  const close60 = candles[idx - 60]?.close;
  if (close60 && close60 > 0) {
    const roc60 = ((c.close - close60) / close60) * 100;
    if (roc60 > 30) { score += 30; details.push(`60d +${roc60.toFixed(0)}%`); }
    else if (roc60 > 15) { score += 20; details.push(`60d +${roc60.toFixed(0)}%`); }
    else if (roc60 > 0) { score += 10; }
  }

  // MA60 rising = long-term fundamental health
  if (c.ma60 != null && idx >= 5) {
    const prevMa60 = candles[idx - 5]?.ma60;
    if (prevMa60 != null && c.ma60 > prevMa60 * 1.005) {
      score += 25;
      details.push('MA60 rising');
    }
  }

  // Price > MA60 and MA20 > MA60 (fundamental uptrend structure)
  if (c.ma60 != null && c.ma20 != null && c.close > c.ma60 && c.ma20 > c.ma60) {
    score += 20;
    details.push('price+MA20 > MA60');
  }

  // New 60-day high: often triggered by revenue/earnings surprise
  let high60 = 0;
  for (let i = idx - 60; i < idx; i++) {
    if (i >= 0 && candles[i].high > high60) high60 = candles[i].high;
  }
  if (c.close > high60) {
    score += 20;
    details.push('new 60d high');
  }

  // Earnings surprise pattern: gap-up + high volume after tight consolidation
  // This is the classic reaction to unexpectedly strong revenue/earnings
  if (idx >= 15) {
    // Check for tight consolidation in prior 10 days (range < 5%)
    let rangeHigh = 0, rangeLow = Infinity;
    for (let i = idx - 10; i < idx - 1; i++) {
      if (i < 0) continue;
      if (candles[i].high > rangeHigh) rangeHigh = candles[i].high;
      if (candles[i].low < rangeLow) rangeLow = candles[i].low;
    }
    const consolidationRange = rangeLow > 0 ? (rangeHigh - rangeLow) / rangeLow : 1;
    const isGapUp = c.open > candles[idx - 1].high;
    const volRatio = c.avgVol5 && c.avgVol5 > 0 ? c.volume / c.avgVol5 : 1;

    if (consolidationRange < 0.05 && isGapUp && volRatio > 2.0) {
      score += 25;
      details.push('earnings surprise pattern');
    } else if (consolidationRange < 0.08 && isGapUp && volRatio > 1.5) {
      score += 15;
      details.push('possible earnings catalyst');
    }
  }

  return { score: clamp(score), detail: details.join(', ') || 'neutral' };
}

// ── Main: Compute Smart Money Score ─────────────────────────────────────────

export function computeSmartMoneyScore(
  candles: CandleWithIndicators[],
  idx: number,
): SmartMoneyResult {
  const accumulation = scoreAccumulation(candles, idx);
  const smartFlow = scoreSmartFlow(candles, idx);
  const buyingPressure = scoreBuyingPressure(candles, idx);
  const institutionalFootprint = scoreInstitutionalFootprint(candles, idx);
  const revenueMomentumProxy = scoreRevenueMomentumProxy(candles, idx);

  const components = { accumulation, smartFlow, buyingPressure, institutionalFootprint, revenueMomentumProxy };

  const totalScore = Math.round(
    accumulation.score * WEIGHTS.accumulation +
    smartFlow.score * WEIGHTS.smartFlow +
    buyingPressure.score * WEIGHTS.buyingPressure +
    institutionalFootprint.score * WEIGHTS.institutionalFootprint +
    revenueMomentumProxy.score * WEIGHTS.revenueMomentumProxy
  );

  return {
    totalScore,
    grade: toGrade(totalScore),
    components,
  };
}

// ── Composite Multi-Factor Score ────────────────────────────────────────────
// Combines: Six Conditions (technical), Surge Score, Smart Money Score
// into a single ranking metric for stock selection

export interface CompositeScoreResult {
  compositeScore: number; // 0-100
  technicalScore: number; // normalized from sixConditions (0-100)
  surgeScore: number;     // 0-100
  smartMoneyScore: number; // 0-100
  histWinRate: number;    // 0-100
  breakdown: string;
}

/**
 * Detect consecutive bullish momentum in recent candles.
 * 3+ consecutive bullish closes with increasing volume = strong entry signal.
 * Returns bonus 0-15 to add to composite score.
 */
export function detectConsecutiveBullish(
  candles: CandleWithIndicators[],
  idx: number,
): { bonus: number; streak: number } {
  if (idx < 5) return { bonus: 0, streak: 0 };

  let streak = 0;
  let volIncreasing = true;
  for (let i = idx; i > idx - 5 && i > 0; i--) {
    if (candles[i].close > candles[i - 1].close) {
      streak++;
      if (i < idx && candles[i].volume < candles[i - 1].volume * 0.8) {
        volIncreasing = false;
      }
    } else {
      break;
    }
  }

  if (streak >= 4 && volIncreasing) return { bonus: 15, streak };
  if (streak >= 3 && volIncreasing) return { bonus: 10, streak };
  if (streak >= 3) return { bonus: 5, streak };
  return { bonus: 0, streak };
}

export function computeCompositeScore(
  sixConditionsScore: number,
  surgeScore: number,
  smartMoneyScore: number,
  histWinRate: number | undefined,
  market?: 'TW' | 'CN',
  consecutiveBullishBonus?: number,
  riskMetrics?: {
    profitFactor?: number;    // histGrossProfit / histGrossLoss
    maxSingleLoss?: number;   // 最大單筆虧損 (negative %)
    ma20Deviation?: number;   // 目前偏離 MA20 幅度 (%)
    rsi?: number;             // RSI(14)
    roc10?: number;           // 10 天漲幅 (%)
  },
  /** IC-based dynamic weights (from factorIC.ts blendWeights) */
  icWeights?: { tech: number; surge: number; smart: number; winRate: number },
): CompositeScoreResult {
  // Normalize six conditions to 0-100
  const technicalScore = (sixConditionsScore / 6) * 100;

  // Effective win rate (default 42 if unknown — conservative)
  const effectiveWinRate = histWinRate ?? 42;

  // Use IC-weighted dynamic weights if provided, otherwise static defaults
  let weights: { tech: number; surge: number; smart: number; winRate: number };
  if (icWeights) {
    weights = icWeights;
  } else {
    // Market-specific static weighting (fallback)
    weights = { tech: 0.20, surge: 0.15, smart: 0.30, winRate: 0.35 };
    if (market === 'TW') {
      weights = { tech: 0.20, surge: 0.12, smart: 0.33, winRate: 0.35 };
    } else if (market === 'CN') {
      weights = { tech: 0.20, surge: 0.18, smart: 0.25, winRate: 0.37 };
    }
  }

  // Surge 分數非線性轉換：防止極端 surge 主導排名（cap at 70）
  const effectiveSurge = Math.min(surgeScore, 70);

  let compositeScore = Math.round(
    technicalScore * weights.tech +
    effectiveSurge * weights.surge +
    smartMoneyScore * weights.smart +
    effectiveWinRate * weights.winRate
  );

  // Add consecutive bullish bonus (capped at 100)
  if (consecutiveBullishBonus) {
    compositeScore = Math.min(100, compositeScore + consecutiveBullishBonus);
  }

  // ── Risk Penalties ─────────────────────────────────────────────────────
  const penalties: string[] = [];
  if (riskMetrics) {
    const { profitFactor, maxSingleLoss, ma20Deviation, rsi, roc10 } = riskMetrics;

    // Profit factor 懲罰：歷史信號虧多賺少
    if (profitFactor != null && profitFactor < 0.7) {
      compositeScore -= 20;
      penalties.push('PF<0.7:-20');
    } else if (profitFactor != null && profitFactor < 1.0) {
      compositeScore -= 10;
      penalties.push('PF<1:-10');
    }

    // 最大單筆虧損懲罰：有過大幅虧損的歷史
    if (maxSingleLoss != null && maxSingleLoss < -8) {
      compositeScore -= 5;
      penalties.push('MaxLoss:-5');
    }

    // 過度延伸懲罰（加嚴版）：降低門檻、加重扣分
    if (ma20Deviation != null && rsi != null && ma20Deviation > 10 && rsi > 65) {
      compositeScore -= 12;
      penalties.push('Overextend:-12');
    }

    // 短期漲幅過大懲罰（分級加重）
    if (roc10 != null && roc10 > 20) {
      compositeScore -= 15;
      penalties.push('ROC10>20%:-15');
    } else if (roc10 != null && roc10 > 15) {
      compositeScore -= 8;
      penalties.push('ROC10>15%:-8');
    }
  }

  compositeScore = Math.max(0, Math.min(100, compositeScore));

  const breakdown = [
    `Tech:${technicalScore.toFixed(0)}`,
    `Surge:${surgeScore}`,
    `Smart:${smartMoneyScore}`,
    `WinRate:${effectiveWinRate}`,
    consecutiveBullishBonus ? `Streak:+${consecutiveBullishBonus}` : '',
    ...penalties,
  ].filter(Boolean).join(' | ');

  return {
    compositeScore,
    technicalScore,
    surgeScore,
    smartMoneyScore,
    histWinRate: effectiveWinRate,
    breakdown,
  };
}
