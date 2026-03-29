/**
 * Gap Analysis — Opening Gap Detection
 *
 * Gaps reveal institutional intent:
 * - Breakaway gap (from consolidation with volume): start of new trend
 * - Continuation gap (mid-trend): trend acceleration
 * - Exhaustion gap (after extended move): potential reversal
 * - Island reversal: gap up then gap down = trapped buyers
 *
 * For our scanner, we focus on:
 * 1. Recent gap-up with volume confirmation = bullish signal
 * 2. Gap fill behavior: unfilled gaps = strong support/resistance
 * 3. Gap frequency: multiple gaps = strong institutional interest
 */

import { CandleWithIndicators } from '@/types';

export interface GapInfo {
  date: string;
  type: 'up' | 'down';
  gapPct: number;       // gap size as %
  filled: boolean;       // has the gap been filled?
  volumeRatio: number;   // volume vs avg at gap
}

export interface GapAnalysisResult {
  /** Score adjustment: -8 to +8 */
  compositeAdjust: number;
  /** Number of unfilled gap-ups in last 20 days */
  unfilledGapUps: number;
  /** Recent gap pattern detected */
  pattern: 'breakaway' | 'continuation' | 'exhaustion' | 'none';
  detail: string;
}

/**
 * Analyze gaps in recent price data.
 */
export function analyzeGaps(
  candles: CandleWithIndicators[],
  idx: number,
): GapAnalysisResult {
  if (idx < 20) {
    return { compositeAdjust: 0, unfilledGapUps: 0, pattern: 'none', detail: 'insufficient data' };
  }

  const details: string[] = [];
  const gaps: GapInfo[] = [];
  const lookback = Math.min(idx, 30);

  // Detect all gaps in lookback period
  for (let i = idx - lookback + 1; i <= idx; i++) {
    if (i < 1) continue;
    const c = candles[i];
    const prev = candles[i - 1];

    // Gap up: today's low > yesterday's high
    if (c.low > prev.high) {
      const gapPct = (c.low - prev.high) / prev.high * 100;
      if (gapPct > 0.3) { // minimum 0.3% gap to be meaningful
        const volRatio = c.avgVol5 && c.avgVol5 > 0 ? c.volume / c.avgVol5 : 1;
        // Check if gap has been filled (price returned to prev.high level)
        let filled = false;
        for (let j = i + 1; j <= idx; j++) {
          if (candles[j].low <= prev.high) { filled = true; break; }
        }
        gaps.push({
          date: String(c.date),
          type: 'up',
          gapPct,
          filled,
          volumeRatio: volRatio,
        });
      }
    }

    // Gap down: today's high < yesterday's low
    if (c.high < prev.low) {
      const gapPct = (prev.low - c.high) / prev.low * 100;
      if (gapPct > 0.3) {
        const volRatio = c.avgVol5 && c.avgVol5 > 0 ? c.volume / c.avgVol5 : 1;
        let filled = false;
        for (let j = i + 1; j <= idx; j++) {
          if (candles[j].high >= prev.low) { filled = true; break; }
        }
        gaps.push({
          date: String(c.date),
          type: 'down',
          gapPct,
          filled,
          volumeRatio: volRatio,
        });
      }
    }
  }

  const gapUps = gaps.filter(g => g.type === 'up');
  const unfilledGapUps = gapUps.filter(g => !g.filled).length;
  let adjust = 0;
  let pattern: GapAnalysisResult['pattern'] = 'none';

  // ── Unfilled gap-ups = strong support (institutional demand) ──────────
  if (unfilledGapUps >= 2) {
    adjust += 6;
    details.push(`${unfilledGapUps} unfilled gap-ups`);
  } else if (unfilledGapUps === 1) {
    adjust += 3;
  }

  // ── Recent gap-up with volume = breakaway or continuation ─────────────
  const recentGapUp = gapUps.find(g => {
    const gapDate = new Date(g.date);
    const current = new Date(String(candles[idx].date));
    const daysDiff = Math.abs(current.getTime() - gapDate.getTime()) / (1000 * 60 * 60 * 24);
    return daysDiff <= 5; // within last 5 trading days
  });

  if (recentGapUp) {
    if (recentGapUp.volumeRatio > 2.0 && recentGapUp.gapPct > 2) {
      pattern = 'breakaway';
      adjust += 5;
      details.push(`breakaway gap ${recentGapUp.gapPct.toFixed(1)}%`);
    } else if (recentGapUp.volumeRatio > 1.5) {
      pattern = 'continuation';
      adjust += 3;
      details.push('continuation gap');
    }
  }

  // ── Exhaustion gap warning: gap up after 8+ day rally ─────────────────
  if (recentGapUp) {
    let upDays = 0;
    for (let i = idx - 1; i >= Math.max(0, idx - 10); i--) {
      if (i > 0 && candles[i].close > candles[i - 1].close) upDays++;
      else break;
    }
    if (upDays >= 8) {
      pattern = 'exhaustion';
      adjust -= 4;
      details.push('exhaustion gap warning');
    }
  }

  // ── Recent gap-down = bearish ──────────────────────────────────────────
  const recentGapDown = gaps.filter(g => g.type === 'down').find(g => {
    const gapDate = new Date(g.date);
    const current = new Date(String(candles[idx].date));
    const daysDiff = Math.abs(current.getTime() - gapDate.getTime()) / (1000 * 60 * 60 * 24);
    return daysDiff <= 3;
  });
  if (recentGapDown && !recentGapDown.filled) {
    adjust -= 4;
    details.push('recent unfilled gap-down');
  }

  return {
    compositeAdjust: Math.max(-8, Math.min(8, adjust)),
    unfilledGapUps,
    pattern,
    detail: details.join(', ') || 'no significant gaps',
  };
}
