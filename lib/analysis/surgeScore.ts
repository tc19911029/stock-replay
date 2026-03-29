/**
 * 飆股潛力評分引擎 (Surge Potential Score)
 *
 * 在六大條件（進場門檻）之上，進一步評估每支股票的「飆漲潛力」。
 * 總分 0–100，由 8 個子分數加權合成。
 */

import { CandleWithIndicators } from '@/types';
import { detectTrend, detectTrendPosition } from './trendAnalysis';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SurgeComponent {
  score: number;  // 0–100
  detail: string;
}

export interface SurgeScoreResult {
  totalScore: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  components: {
    momentum:    SurgeComponent;
    volatility:  SurgeComponent;
    volume:      SurgeComponent;
    breakout:    SurgeComponent;
    trendQuality: SurgeComponent;
    pricePosition: SurgeComponent;
    kbarStrength: SurgeComponent;
    indicatorConfluence: SurgeComponent;
    longTermQuality: SurgeComponent;
    volumePriceDivergence: SurgeComponent;
  };
  flags: string[];
}

const WEIGHTS = {
  momentum:    0.16,
  volatility:  0.10,
  volume:      0.13,
  breakout:    0.13,
  trendQuality: 0.13,
  pricePosition: 0.05,
  kbarStrength: 0.05,
  indicatorConfluence: 0.05,
  longTermQuality: 0.10,
  volumePriceDivergence: 0.10, // 量價背離偵測：排除弱勢假突破
};

function clamp(v: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, v));
}

function toGrade(score: number): SurgeScoreResult['grade'] {
  if (score >= 80) return 'S';
  if (score >= 65) return 'A';
  if (score >= 50) return 'B';
  if (score >= 35) return 'C';
  return 'D';
}

// ── Sub-score: Momentum Acceleration ─────────────────────────────────────────

function scoreMomentum(candles: CandleWithIndicators[], idx: number): SurgeComponent {
  const c = candles[idx];
  let score = 0;
  const details: string[] = [];

  // RSI in ideal range (45-70)
  if (c.rsi14 != null) {
    if (c.rsi14 >= 45 && c.rsi14 <= 70) { score += 25; details.push(`RSI=${c.rsi14.toFixed(0)}(理想區)`); }
    else if (c.rsi14 > 70) { score += 10; details.push(`RSI=${c.rsi14.toFixed(0)}(偏高)`); }
    else { details.push(`RSI=${c.rsi14.toFixed(0)}(偏低)`); }
  }

  // RSI rising over 3 days
  if (idx >= 3 && c.rsi14 != null && candles[idx - 3].rsi14 != null) {
    const rsiDelta = c.rsi14 - candles[idx - 3].rsi14!;
    if (rsiDelta > 5) { score += 20; details.push('RSI加速↑'); }
    else if (rsiDelta > 0) { score += 10; details.push('RSI緩升'); }
  }

  // ROC acceleration: ROC10 > 0 AND ROC10 > ROC20 (accelerating)
  if (c.roc10 != null && c.roc20 != null) {
    if (c.roc10 > 0 && c.roc10 > c.roc20) { score += 25; details.push(`ROC加速(10d=${c.roc10.toFixed(1)}%)`); }
    else if (c.roc10 > 0) { score += 10; details.push(`ROC正(${c.roc10.toFixed(1)}%)`); }
  }

  // MACD slope positive and increasing
  if (c.macdSlope != null) {
    if (c.macdSlope > 0) {
      score += 20;
      if (idx >= 1 && candles[idx - 1].macdSlope != null && c.macdSlope > candles[idx - 1].macdSlope!) {
        score += 10;
        details.push('MACD柱加速↑');
      } else {
        details.push('MACD柱正增');
      }
    }
  }

  return { score: clamp(score), detail: details.join('，') || '動能一般' };
}

// ── Sub-score: Volatility Expansion ──────────────────────────────────────────

function scoreVolatility(candles: CandleWithIndicators[], idx: number): SurgeComponent {
  const c = candles[idx];
  let score = 0;
  const details: string[] = [];
  const flags: string[] = [];

  // ATR expansion vs 20-day average ATR
  if (idx >= 20 && c.atr14 != null) {
    let atrSum = 0, cnt = 0;
    for (let i = idx - 20; i < idx; i++) {
      if (candles[i].atr14 != null) { atrSum += candles[i].atr14!; cnt++; }
    }
    if (cnt > 0) {
      const avgAtr = atrSum / cnt;
      const ratio = c.atr14 / avgAtr;
      if (ratio > 1.5) { score += 40; details.push(`ATR擴張${ratio.toFixed(1)}x`); }
      else if (ratio > 1.2) { score += 25; details.push(`ATR溫和擴張`); }
    }
  }

  // BB bandwidth expanding
  if (c.bbBandwidth != null && idx >= 5) {
    let bwSum = 0, cnt = 0;
    for (let i = idx - 5; i < idx; i++) {
      if (candles[i].bbBandwidth != null) { bwSum += candles[i].bbBandwidth!; cnt++; }
    }
    if (cnt > 0 && c.bbBandwidth > bwSum / cnt) {
      score += 25;
      details.push('BB帶寬擴張');
    }

    // Squeeze-then-expand: bandwidth was at 20-day low recently
    if (idx >= 20) {
      let minBW = Infinity;
      for (let i = idx - 20; i < idx - 2; i++) {
        if (candles[i].bbBandwidth != null && candles[i].bbBandwidth! < minBW)
          minBW = candles[i].bbBandwidth!;
      }
      // Check if recent 5 days had near-minimum bandwidth
      for (let i = idx - 5; i < idx; i++) {
        if (candles[i].bbBandwidth != null && candles[i].bbBandwidth! < minBW * 1.1) {
          if (c.bbBandwidth > minBW * 1.3) {
            score += 20;
            details.push('BB壓縮後突破');
            flags.push('BB_SQUEEZE_BREAKOUT');
          }
          break;
        }
      }
    }
  }

  // BB %B > 0.8 (price riding upper band)
  if (c.bbPercentB != null && c.bbPercentB > 0.8) {
    score += 15;
    details.push(`%B=${(c.bbPercentB * 100).toFixed(0)}%(沿上軌)`);
  }

  return { score: clamp(score), detail: details.join('，') || '波動平穩' };
}

// ── Sub-score: Volume Buildup ────────────────────────────────────────────────

function scoreVolume(candles: CandleWithIndicators[], idx: number): SurgeComponent {
  const c = candles[idx];
  let score = 0;
  const details: string[] = [];

  // avgVol5 > avgVol20 (short-term volume climbing)
  if (c.avgVol5 != null && c.avgVol20 != null && c.avgVol20 > 0) {
    const ratio = c.avgVol5 / c.avgVol20;
    if (ratio > 1.5) { score += 30; details.push(`5日均量>${ratio.toFixed(1)}x 20日`); }
    else if (ratio > 1.2) { score += 20; details.push('近期量能攀升'); }
  }

  // Today volume spike
  if (c.avgVol5 != null && c.avgVol5 > 0) {
    const todayRatio = c.volume / c.avgVol5;
    if (todayRatio > 3) { score += 30; details.push(`今日爆量${todayRatio.toFixed(1)}x`); }
    else if (todayRatio > 2) { score += 25; details.push(`今日放量${todayRatio.toFixed(1)}x`); }
    else if (todayRatio > 1.5) { score += 15; details.push(`量增${todayRatio.toFixed(1)}x`); }
  }

  // 3-day increasing volume
  if (idx >= 3) {
    const v1 = candles[idx - 2].volume;
    const v2 = candles[idx - 1].volume;
    const v3 = c.volume;
    if (v3 > v2 && v2 > v1 && v3 > v1 * 1.3) {
      score += 20;
      details.push('連3日量增');
    }
  }

  // Volume + price alignment (volume up + price up)
  if (idx >= 1 && c.volume > candles[idx - 1].volume && c.close > candles[idx - 1].close) {
    score += 20;
    details.push('量價齊揚');
  }

  return { score: clamp(score), detail: details.join('，') || '量能一般' };
}

// ── Sub-score: Breakout Pattern ──────────────────────────────────────────────

function scoreBreakout(candles: CandleWithIndicators[], idx: number): SurgeComponent {
  const c = candles[idx];
  let score = 0;
  const details: string[] = [];

  // 突破 20 日高點
  if (idx >= 20) {
    let high20 = -Infinity;
    for (let i = idx - 20; i < idx; i++) high20 = Math.max(high20, candles[i].high);
    if (c.close > high20) { score += 30; details.push('突破20日新高'); }
  }

  // 突破 60 日高點 (更強)
  if (idx >= 60) {
    let high60 = -Infinity;
    for (let i = idx - 60; i < idx; i++) high60 = Math.max(high60, candles[i].high);
    if (c.close > high60) { score += 20; details.push('突破60日新高'); }
  }

  // 整理區間突破: 20日內價格區間 < 15%, 今天突破上緣
  if (idx >= 20) {
    let rangeHigh = -Infinity, rangeLow = Infinity;
    for (let i = idx - 20; i < idx; i++) {
      rangeHigh = Math.max(rangeHigh, candles[i].high);
      rangeLow = Math.min(rangeLow, candles[i].low);
    }
    const rangeWidth = rangeLow > 0 ? (rangeHigh - rangeLow) / rangeLow : 1;
    if (rangeWidth < 0.15 && c.close > rangeHigh) {
      score += 25;
      details.push(`整理區間突破(區間${(rangeWidth * 100).toFixed(0)}%)`);
    }
  }

  // 均線糾結後發散: MA5, MA10, MA20 在 3% 內，且今天 MA5 拉開
  if (c.ma5 != null && c.ma10 != null && c.ma20 != null && c.ma20 > 0) {
    if (idx >= 5) {
      const prev = candles[idx - 5];
      if (prev.ma5 != null && prev.ma10 != null && prev.ma20 != null && prev.ma20 > 0) {
        const prevSpread = (Math.max(prev.ma5, prev.ma10, prev.ma20) - Math.min(prev.ma5, prev.ma10, prev.ma20)) / prev.ma20;
        const currSpread = (Math.max(c.ma5, c.ma10, c.ma20) - Math.min(c.ma5, c.ma10, c.ma20)) / c.ma20;
        if (prevSpread < 0.03 && currSpread > prevSpread * 1.5 && c.ma5 > c.ma10) {
          score += 25;
          details.push('均線糾結後發散');
        }
      }
    }
  }

  return { score: clamp(score), detail: details.join('，') || '無明顯突破' };
}

// ── Sub-score: Trend Quality ─────────────────────────────────────────────────

function scoreTrendQuality(candles: CandleWithIndicators[], idx: number): SurgeComponent {
  const c = candles[idx];
  let score = 0;
  const details: string[] = [];

  // Full MA alignment: MA5 > MA10 > MA20 > MA60
  if (c.ma5 != null && c.ma10 != null && c.ma20 != null && c.ma60 != null) {
    if (c.ma5 > c.ma10 && c.ma10 > c.ma20 && c.ma20 > c.ma60) {
      score += 35;
      details.push('四線多排');
    } else if (c.ma5 > c.ma10 && c.ma10 > c.ma20) {
      score += 20;
      details.push('三線多排');
    }
  }

  // All MAs rising
  if (idx >= 1) {
    const p = candles[idx - 1];
    let risingCount = 0;
    if (c.ma5 != null && p.ma5 != null && c.ma5 > p.ma5) risingCount++;
    if (c.ma10 != null && p.ma10 != null && c.ma10 > p.ma10) risingCount++;
    if (c.ma20 != null && p.ma20 != null && c.ma20 > p.ma20) risingCount++;
    if (risingCount === 3) { score += 30; details.push('三線齊升'); }
    else if (risingCount >= 2) { score += 15; details.push(`${risingCount}線上升`); }
  }

  // Higher highs + higher lows in recent 10 bars
  if (idx >= 10) {
    let hh = 0, hl = 0;
    for (let i = idx - 9; i <= idx; i++) {
      if (candles[i].high > candles[i - 1].high) hh++;
      if (candles[i].low > candles[i - 1].low) hl++;
    }
    const waveScore = Math.min(35, Math.round((hh + hl) / 20 * 35));
    if (waveScore > 15) {
      score += waveScore;
      details.push(`波浪結構(HH${hh}/HL${hl})`);
    }
  }

  return { score: clamp(score), detail: details.join('，') || '趨勢品質一般' };
}

// ── Sub-score: Price Position ────────────────────────────────────────────────

function scorePricePosition(candles: CandleWithIndicators[], idx: number): SurgeComponent {
  const position = detectTrendPosition(candles, idx);
  const trend = detectTrend(candles, idx);

  let score = 0;
  if (trend === '多頭') {
    if (position === '起漲段') score = 100;
    else if (position === '主升段') {
      // Check deviation more precisely
      const c = candles[idx];
      const dev = c.ma20 && c.ma20 > 0 ? (c.close - c.ma20) / c.ma20 : 0;
      if (dev < 0.10) score = 70;
      else if (dev < 0.15) score = 45;
      else score = 20;
    }
    else score = 0; // 末升段
  } else if (trend === '盤整') {
    score = 25; // Some potential for breakout
  }

  return { score, detail: `${trend}/${position}` };
}

// ── Sub-score: K-Bar Strength ────────────────────────────────────────────────

function scoreKbarStrength(candles: CandleWithIndicators[], idx: number): SurgeComponent {
  const c = candles[idx];
  const bodyAbs = Math.abs(c.close - c.open);
  const bodyPct = c.open > 0 ? bodyAbs / c.open : 0;
  const isRed = c.close > c.open;
  const dayRange = c.high - c.low;
  const closePos = dayRange > 0 ? (c.close - c.low) / dayRange : 0.5;
  const upperShadow = dayRange > 0 ? (c.high - c.close) / dayRange : 0;

  let score = 0;
  const details: string[] = [];

  if (isRed) {
    if (bodyPct >= 0.05) { score += 50; details.push(`大陽線(${(bodyPct*100).toFixed(1)}%)`); }
    else if (bodyPct >= 0.03) { score += 35; details.push(`中紅K(${(bodyPct*100).toFixed(1)}%)`); }
    else if (bodyPct >= 0.02) { score += 20; details.push('小紅K'); }
  } else {
    details.push('黑K');
  }

  if (closePos >= 0.8) { score += 30; details.push('收最高'); }
  else if (closePos >= 0.6) { score += 15; }

  if (upperShadow < 0.1) { score += 20; details.push('無上影線'); }

  return { score: clamp(score), detail: details.join('，') || 'K棒力道弱' };
}

// ── Sub-score: Indicator Confluence ──────────────────────────────────────────

function scoreIndicatorConfluence(candles: CandleWithIndicators[], idx: number): SurgeComponent {
  const c = candles[idx];
  const prev = idx > 0 ? candles[idx - 1] : null;
  let score = 0;
  const details: string[] = [];

  const macdBull = c.macdOSC != null && c.macdOSC > 0;
  const kdBull = c.kdK != null && c.kdD != null && c.kdK > c.kdD;

  if (macdBull && kdBull) { score += 50; details.push('MACD+KD共振看多'); }
  else if (macdBull) { score += 25; details.push('MACD看多'); }
  else if (kdBull) { score += 20; details.push('KD看多'); }

  // MACD golden cross today
  if (prev && c.macdOSC != null && prev.macdOSC != null && c.macdOSC > 0 && prev.macdOSC <= 0) {
    score += 25;
    details.push('MACD金叉');
  }

  // KD golden cross today
  if (prev && c.kdK != null && c.kdD != null && prev.kdK != null && prev.kdD != null) {
    if (c.kdK > c.kdD && prev.kdK <= prev.kdD) {
      score += 25;
      details.push('KD金叉');
    }
  }

  return { score: clamp(score), detail: details.join('，') || '指標未共振' };
}

// ── Sub-score: Long-Term Quality ─────────────────────────────────────────────
// 區分「結構性多頭股」vs「死貓跳/弱勢反彈」
// 歷史數據顯示：長期弱勢股即使短期技術面好看，20日回報仍然負面

function scoreLongTermQuality(candles: CandleWithIndicators[], idx: number): SurgeComponent {
  const c = candles[idx];
  let score = 0;
  const details: string[] = [];

  // 60日ROC > 0 = 股票中期是在上漲的
  if (c.roc20 != null && idx >= 60) {
    const close60 = candles[idx - 60]?.close;
    if (close60 && close60 > 0) {
      const roc60 = ((c.close - close60) / close60) * 100;
      if (roc60 > 20) { score += 40; details.push(`60日漲${roc60.toFixed(0)}%(強勢)`); }
      else if (roc60 > 5) { score += 30; details.push(`60日漲${roc60.toFixed(0)}%`); }
      else if (roc60 > 0) { score += 15; details.push(`60日微漲`); }
      else { details.push(`60日跌${roc60.toFixed(0)}%(弱勢)`); } // 0分
    }
  }

  // MA60 向上 = 長期趨勢健康
  if (idx >= 1 && c.ma60 != null) {
    const prevMa60 = candles[idx - 1]?.ma60;
    if (prevMa60 != null && c.ma60 > prevMa60) {
      score += 25;
      details.push('MA60向上');
    }
  }

  // 股價 > MA60 = 站在長期均線之上
  if (c.ma60 != null && c.close > c.ma60) {
    score += 20;
    details.push('價>MA60');
  }

  // 20日ROC > 60日ROC（加速上漲）
  if (c.roc20 != null && idx >= 60) {
    const close60 = candles[idx - 60]?.close;
    if (close60 && close60 > 0) {
      const roc60 = ((c.close - close60) / close60) * 100;
      if (c.roc20 > roc60 / 3) { // 近期漲幅佔長期漲幅的合理比例
        score += 15;
        details.push('加速上漲');
      }
    }
  }

  return { score: clamp(score), detail: details.join('，') || '長期品質不明' };
}

// ── Sub-score: Volume-Price Divergence ──────────────────────────────────────
// Detects mismatches between price trend and volume trend.
// Bullish divergence (price flat/down but volume pattern bullish) = accumulation
// Bearish divergence (price up but volume shrinking) = distribution risk

function scoreVolumePriceDivergence(candles: CandleWithIndicators[], idx: number): SurgeComponent {
  let score = 50; // neutral baseline
  const details: string[] = [];
  if (idx < 20) return { score: 50, detail: 'data insufficient' };

  // Compare price trend vs volume trend over 10 days
  const priceNow = candles[idx].close;
  const price10 = candles[idx - 10]?.close;
  const priceTrend = price10 && price10 > 0 ? (priceNow - price10) / price10 : 0;

  // Volume trend: compare avg volume last 5 days vs 5 days before that
  let recentVol = 0, priorVol = 0;
  for (let i = idx - 4; i <= idx; i++) {
    if (i >= 0) recentVol += candles[i].volume;
  }
  for (let i = idx - 9; i <= idx - 5; i++) {
    if (i >= 0) priorVol += candles[i].volume;
  }
  recentVol /= 5;
  priorVol /= 5;
  const volTrend = priorVol > 0 ? (recentVol - priorVol) / priorVol : 0;

  // Healthy: price up + volume up (confirmation)
  if (priceTrend > 0.03 && volTrend > 0.1) {
    score = 85;
    details.push('price+vol confirmation');
  }
  // Bullish divergence: price flat/down but volume increasing on up days
  else if (priceTrend <= 0.02 && volTrend > 0.15) {
    let upDayVol = 0, downDayVol = 0;
    for (let i = idx - 4; i <= idx; i++) {
      if (i > 0 && candles[i].close > candles[i - 1].close) upDayVol += candles[i].volume;
      else if (i > 0) downDayVol += candles[i].volume;
    }
    if (upDayVol > downDayVol * 1.3) {
      score = 80;
      details.push('bullish divergence (accumulation)');
    } else {
      score = 55;
    }
  }
  // Strong bearish: price up but volume collapsing
  else if (priceTrend > 0.05 && volTrend < -0.3) {
    score = 10;
    details.push('strong bearish divergence');
  }
  // Bearish divergence: price rising but volume declining
  else if (priceTrend > 0.03 && volTrend < -0.15) {
    score = 25;
    details.push('bearish divergence (distribution risk)');
  }

  // Check for volume dry-up then spike (accumulation completion signal)
  if (idx >= 10) {
    let minVol = Infinity;
    for (let i = idx - 10; i < idx - 2; i++) {
      if (i >= 0) minVol = Math.min(minVol, candles[i].volume);
    }
    const todayVol = candles[idx].volume;
    if (minVol !== Infinity && todayVol > minVol * 3 && candles[idx].close > candles[idx].open) {
      score = Math.max(score, 90);
      details.push('volume dry-up→spike');
    }
  }

  return { score: clamp(score), detail: details.join(', ') || 'neutral' };
}

// ── Main: Compute Surge Score ────────────────────────────────────────────────

export function computeSurgeScore(
  candles: CandleWithIndicators[],
  idx: number,
): SurgeScoreResult {
  const momentum    = scoreMomentum(candles, idx);
  const volatility  = scoreVolatility(candles, idx);
  const volume      = scoreVolume(candles, idx);
  const breakout    = scoreBreakout(candles, idx);
  const trendQuality = scoreTrendQuality(candles, idx);
  const pricePosition = scorePricePosition(candles, idx);
  const kbarStrength = scoreKbarStrength(candles, idx);
  const indicatorConfluence = scoreIndicatorConfluence(candles, idx);

  const longTermQuality = scoreLongTermQuality(candles, idx);
  const volumePriceDivergence = scoreVolumePriceDivergence(candles, idx);

  const components = { momentum, volatility, volume, breakout, trendQuality, pricePosition, kbarStrength, indicatorConfluence, longTermQuality, volumePriceDivergence };

  const totalScore = Math.round(
    momentum.score * WEIGHTS.momentum +
    volatility.score * WEIGHTS.volatility +
    volume.score * WEIGHTS.volume +
    breakout.score * WEIGHTS.breakout +
    trendQuality.score * WEIGHTS.trendQuality +
    pricePosition.score * WEIGHTS.pricePosition +
    kbarStrength.score * WEIGHTS.kbarStrength +
    indicatorConfluence.score * WEIGHTS.indicatorConfluence +
    longTermQuality.score * WEIGHTS.longTermQuality +
    volumePriceDivergence.score * WEIGHTS.volumePriceDivergence
  );

  // Collect flags
  const flags: string[] = [];
  if (volatility.detail.includes('BB壓縮後突破')) flags.push('BB_SQUEEZE_BREAKOUT');
  if (volume.score >= 70) flags.push('VOLUME_CLIMAX');
  if (breakout.detail.includes('均線糾結後發散')) flags.push('MA_CONVERGENCE_BREAKOUT');
  if (breakout.detail.includes('整理區間突破')) flags.push('CONSOLIDATION_BREAKOUT');
  if (breakout.detail.includes('60日新高')) flags.push('NEW_60D_HIGH');
  if (momentum.detail.includes('ROC加速')) flags.push('MOMENTUM_ACCELERATION');
  if (volume.detail.includes('連3日量增')) flags.push('PROGRESSIVE_VOLUME');
  if (volumePriceDivergence.detail.includes('bearish divergence')) flags.push('BEARISH_VOL_DIVERGENCE');
  if (volumePriceDivergence.detail.includes('bullish divergence')) flags.push('BULLISH_VOL_DIVERGENCE');
  if (volumePriceDivergence.detail.includes('dry-up')) flags.push('VOLUME_DRY_SPIKE');

  return {
    totalScore,
    grade: toGrade(totalScore),
    components,
    flags,
  };
}
