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
import { GAP_ANALYSIS_MIN_HISTORY } from './historyMinimums';

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
  pattern: 'breakaway' | 'continuation' | 'exhaustion' | 'island_reversal_bear' | 'island_reversal_bull' | 'none';
  detail: string;
  /** 缺口4層支撐/壓力（朱老師 Part 9） */
  gapSupport?: GapSupportLevels;
}

/** 缺口形成的4個支撐/壓力價位（由強到弱） */
export interface GapSupportLevels {
  /** 上高：缺口後K線高點（最強支撐） */
  upperHigh: number;
  /** 上沿：缺口後K線低點 */
  upperEdge: number;
  /** 下沿：缺口前K線高點 */
  lowerEdge: number;
  /** 下底：缺口前K線低點（最弱支撐） */
  lowerBottom: number;
}

/**
 * Analyze gaps in recent price data.
 */
export function analyzeGaps(
  candles: CandleWithIndicators[],
  idx: number,
): GapAnalysisResult {
  if (idx < GAP_ANALYSIS_MIN_HISTORY) {
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

  // ── 島型反轉（朱老師 Part 9, p.607 + Part 12-4 #17）─────────────────
  // 高檔島型反轉（bearish）：先向上跳空，幾天後再向下跳空 → 形成孤島
  // 低檔島型反轉（bullish）：先向下跳空，幾天後再向上跳空 → V型反彈
  for (let i = 0; i < gaps.length; i++) {
    const g1 = gaps[i];
    // 找 g1 之後方向相反的缺口
    for (let j = i + 1; j < gaps.length; j++) {
      const g2 = gaps[j];
      if (g1.type === g2.type) continue;
      const d1 = new Date(g1.date).getTime();
      const d2 = new Date(g2.date).getTime();
      const daysBetween = Math.abs(d2 - d1) / (1000 * 60 * 60 * 24);
      if (daysBetween > 10) continue; // 島型反轉通常在10天內完成

      // 高檔島型反轉：先向上跳空(up)後向下跳空(down)
      if (g1.type === 'up' && g2.type === 'down') {
        const isRecent = new Date(g2.date).getTime() >=
          new Date(String(candles[Math.max(0, idx - 5)].date)).getTime();
        if (isRecent) {
          pattern = 'island_reversal_bear';
          adjust -= 8;
          details.push(`高檔島型反轉（${g1.date}向上跳空→${g2.date}向下跳空）`);
        }
      }
      // 低檔島型反轉：先向下跳空(down)後向上跳空(up)
      if (g1.type === 'down' && g2.type === 'up') {
        const isRecent = new Date(g2.date).getTime() >=
          new Date(String(candles[Math.max(0, idx - 5)].date)).getTime();
        if (isRecent) {
          pattern = 'island_reversal_bull';
          adjust += 6;
          details.push(`低檔島型反轉（${g1.date}向下跳空→${g2.date}向上跳空）`);
        }
      }
    }
  }

  // ── 缺口4層支撐/壓力系統（朱老師 Part 9, p.617-618）──────────────────
  // 取最近一個未回補的向上跳空缺口，計算4層支撐
  let gapSupport: GapSupportLevels | undefined;
  const lastUnfilledUp = gapUps.filter(g => !g.filled).slice(-1)[0];
  if (lastUnfilledUp) {
    const gapIdx = candles.findIndex(c => String(c.date) === lastUnfilledUp.date);
    if (gapIdx > 0) {
      const gapCandle = candles[gapIdx];
      const prevCandle = candles[gapIdx - 1];
      gapSupport = {
        upperHigh: gapCandle.high,    // 上高（最強支撐）
        upperEdge: gapCandle.low,     // 上沿
        lowerEdge: prevCandle.high,   // 下沿
        lowerBottom: prevCandle.low,  // 下底（最弱支撐）
      };
    }
  }

  return {
    compositeAdjust: Math.max(-8, Math.min(8, adjust)),
    unfilledGapUps,
    pattern,
    detail: details.join(', ') || 'no significant gaps',
    gapSupport,
  };
}
