/**
 * Factor IC (Information Coefficient) — Dynamic Factor Weighting
 *
 * Computes the rank correlation (Spearman) between each factor's score
 * and the stock's subsequent 5-day return across historical signals.
 * Factors with higher IC get higher weight in composite scoring;
 * factors near IC=0 are automatically down-weighted.
 *
 * Research basis:
 * - IC-mean-weighted predictor achieves 13.8% annualized return,
 *   39.09% excess return vs CSI 300 (2024 ML+dynamic weighting study)
 * - Dynamic weighting adapts to regime changes automatically
 */

export interface FactorICEntry {
  factorName: string;
  ic: number;        // Spearman rank correlation [-1, 1]
  absIC: number;     // |IC| for weighting
}

export interface ICWeightedResult {
  factors: FactorICEntry[];
  weights: Record<string, number>;  // normalized weights summing to 1
  dataPoints: number;               // how many data points used
}

/**
 * Compute Spearman rank correlation between two arrays.
 * Returns value in [-1, 1].
 */
function spearmanCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 5) return 0;

  // Rank arrays
  const rankX = toRanks(x);
  const rankY = toRanks(y);

  // Pearson correlation on ranks
  let sumXY = 0, sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += rankX[i];
    sumY += rankY[i];
    sumXY += rankX[i] * rankY[i];
    sumX2 += rankX[i] ** 2;
    sumY2 += rankY[i] ** 2;
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX ** 2) * (n * sumY2 - sumY ** 2)
  );

  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Convert values to ranks (1-based, average rank for ties).
 */
function toRanks(arr: number[]): number[] {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array<number>(arr.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    // Find group of ties
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
    // Average rank for tied values
    const avgRank = (i + j + 1) / 2; // 1-based
    for (let k = i; k < j; k++) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j;
  }
  return ranks;
}

/**
 * Historical signal record for IC calculation.
 * Each entry represents one past signal with its factor scores
 * and subsequent 5-day return.
 */
export interface HistoricalSignalForIC {
  techScore: number;       // six conditions normalized 0-100
  surgeScore: number;      // 0-100
  smartMoneyScore: number; // 0-100
  histWinRate: number;     // 0-100
  forwardReturn: number;   // 5-day return %
}

/**
 * Compute IC for each factor and return dynamic weights.
 *
 * @param signals Historical signals with forward returns (minimum 15 recommended)
 * @param minIC   Minimum |IC| to include factor (below this → floor weight)
 * @returns Dynamic weights normalized to sum to 1
 */
export function computeFactorIC(
  signals: HistoricalSignalForIC[],
): ICWeightedResult {
  if (signals.length < 10) {
    // Not enough data — return equal weights (fallback)
    return {
      factors: [],
      weights: { tech: 0.25, surge: 0.25, smart: 0.25, winRate: 0.25 },
      dataPoints: signals.length,
    };
  }

  const returns = signals.map(s => s.forwardReturn);

  const factorArrays: Record<string, number[]> = {
    tech:    signals.map(s => s.techScore),
    surge:   signals.map(s => s.surgeScore),
    smart:   signals.map(s => s.smartMoneyScore),
    winRate: signals.map(s => s.histWinRate),
  };

  const factors: FactorICEntry[] = [];
  for (const [name, values] of Object.entries(factorArrays)) {
    const ic = spearmanCorrelation(values, returns);
    factors.push({ factorName: name, ic, absIC: Math.abs(ic) });
  }

  // IC-mean weighting: weight proportional to |IC|
  // Floor: every factor gets at least 0.05 weight to prevent complete zeroing
  const FLOOR = 0.05;
  const totalAbsIC = factors.reduce((sum, f) => sum + Math.max(f.absIC, FLOOR), 0);

  const weights: Record<string, number> = {};
  for (const f of factors) {
    weights[f.factorName] = Math.max(f.absIC, FLOOR) / totalAbsIC;
  }

  return { factors, weights, dataPoints: signals.length };
}

/**
 * Merge IC-based weights with static market-specific defaults.
 * Uses a blend ratio: 60% IC-based + 40% static defaults (for stability).
 *
 * @param icWeights  Dynamic weights from computeFactorIC
 * @param market     Market for static defaults
 * @param blendRatio How much to trust IC weights vs static (0-1, default 0.6)
 */
export function blendWeights(
  icWeights: Record<string, number>,
  market: 'TW' | 'CN' | undefined,
  blendRatio = 0.6,
): { tech: number; surge: number; smart: number; winRate: number } {
  // Static defaults by market
  let staticW = { tech: 0.20, surge: 0.15, smart: 0.30, winRate: 0.35 };
  if (market === 'TW') {
    staticW = { tech: 0.20, surge: 0.12, smart: 0.33, winRate: 0.35 };
  } else if (market === 'CN') {
    staticW = { tech: 0.20, surge: 0.18, smart: 0.25, winRate: 0.37 };
  }

  const blend = (key: 'tech' | 'surge' | 'smart' | 'winRate') =>
    (icWeights[key] ?? staticW[key]) * blendRatio + staticW[key] * (1 - blendRatio);

  const raw = {
    tech:    blend('tech'),
    surge:   blend('surge'),
    smart:   blend('smart'),
    winRate: blend('winRate'),
  };

  // Normalize to sum to 1
  const total = raw.tech + raw.surge + raw.smart + raw.winRate;
  return {
    tech:    raw.tech / total,
    surge:   raw.surge / total,
    smart:   raw.smart / total,
    winRate: raw.winRate / total,
  };
}
