/**
 * Pressure Zone Analysis (壓力區偵測)
 *
 * Builds a volume-at-price histogram from historical candles to identify
 * high-volume areas where many traders are trapped (套牢壓力區).
 *
 * When a stock approaches these zones, it faces significant selling pressure
 * from trapped holders looking to exit at breakeven. The system penalises
 * entries heading into heavy overhead supply and rewards clean breakouts
 * above all historical volume clusters.
 */

import { CandleWithIndicators } from '@/types';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PressureZone {
  /** Lower bound of the zone */
  low: number;
  /** Upper bound of the zone */
  high: number;
  /** Cumulative volume within the zone */
  totalVolume: number;
  /** Normalised strength 0-100 */
  strength: number;
  /** Position relative to current price */
  position: 'overhead' | 'support' | 'current';
}

export interface PressureZoneResult {
  /** Composite score adjustment: -25 (heavy overhead) to +10 (clean air) */
  compositeAdjust: number;
  /** 0-100 overhead pressure intensity */
  overheadPressure: number;
  /** Nearest overhead zone (if any) */
  nearestOverheadZone?: { low: number; high: number; strength: number };
  /** Distance to nearest overhead zone as percentage */
  overheadDistancePct: number;
  /** All detected pressure zones */
  zones: PressureZone[];
  detail: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Simple ATR(14) calculation from raw candle data.
 * Returns 0 if insufficient data.
 */
function computeATR(candles: CandleWithIndicators[], idx: number, period = 14): number {
  // Prefer pre-computed ATR if available
  const preComputed = candles[idx].atr14;
  if (preComputed && preComputed > 0) return preComputed;

  if (idx < period) return 0;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    sum += tr;
  }
  return sum / period;
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Analyse historical volume distribution to detect pressure zones.
 *
 * @param candles  Full candle array with indicators
 * @param idx      Index of the "current" candle to evaluate
 * @param lookback How many candles to look back (default 120)
 */
export function analyzePressureZones(
  candles: CandleWithIndicators[],
  idx: number,
  lookback = 120,
): PressureZoneResult {
  const neutral: PressureZoneResult = {
    compositeAdjust: 0,
    overheadPressure: 0,
    overheadDistancePct: 100,
    zones: [],
    detail: 'insufficient data',
  };

  if (idx < 30) return neutral;

  const current = candles[idx];
  const price = current.close;
  const atr = computeATR(candles, idx);
  if (atr <= 0) return neutral;

  // ── 1. Build volume-at-price histogram ────────────────────────────────────
  // Bin width = ATR * 0.5 (adaptive to stock's volatility)
  const binWidth = atr * 0.5;
  const startIdx = Math.max(0, idx - lookback);
  const volumeMap = new Map<number, number>(); // binKey → cumulative volume

  for (let i = startIdx; i <= idx; i++) {
    const c = candles[i];
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const binKey = Math.floor(typicalPrice / binWidth);
    volumeMap.set(binKey, (volumeMap.get(binKey) ?? 0) + c.volume);
  }

  if (volumeMap.size === 0) return neutral;

  // ── 2. Statistical thresholding ───────────────────────────────────────────
  const volumes = Array.from(volumeMap.values());
  const mean = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const variance = volumes.reduce((a, b) => a + (b - mean) ** 2, 0) / volumes.length;
  const stddev = Math.sqrt(variance);
  const threshold = mean + 0.5 * stddev;

  // ── 3. Identify significant bins ──────────────────────────────────────────
  const significantBins: Array<{ binKey: number; volume: number }> = [];
  for (const [binKey, vol] of volumeMap.entries()) {
    if (vol >= threshold) {
      significantBins.push({ binKey, volume: vol });
    }
  }

  if (significantBins.length === 0) {
    return {
      compositeAdjust: 3,
      overheadPressure: 0,
      overheadDistancePct: 100,
      zones: [],
      detail: '無顯著壓力區（量能分散）',
    };
  }

  // Sort by bin position
  significantBins.sort((a, b) => a.binKey - b.binKey);

  // ── 4. Merge adjacent bins into contiguous zones ──────────────────────────
  const rawZones: Array<{ lowBin: number; highBin: number; totalVol: number }> = [];
  let zoneStart = significantBins[0].binKey;
  let zoneEnd = significantBins[0].binKey;
  let zoneVol = significantBins[0].volume;

  for (let i = 1; i < significantBins.length; i++) {
    const bin = significantBins[i];
    if (bin.binKey <= zoneEnd + 2) {
      // Adjacent or close — merge (allow 1 gap bin between significant bins)
      zoneEnd = bin.binKey;
      zoneVol += bin.volume;
    } else {
      rawZones.push({ lowBin: zoneStart, highBin: zoneEnd, totalVol: zoneVol });
      zoneStart = bin.binKey;
      zoneEnd = bin.binKey;
      zoneVol = bin.volume;
    }
  }
  rawZones.push({ lowBin: zoneStart, highBin: zoneEnd, totalVol: zoneVol });

  // ── 5. Convert to price-space zones & classify ────────────────────────────
  const maxZoneVol = Math.max(...rawZones.map(z => z.totalVol));
  const priceBinKey = Math.floor(price / binWidth);

  const zones: PressureZone[] = rawZones.map(z => {
    const low = z.lowBin * binWidth;
    const high = (z.highBin + 1) * binWidth;
    const strength = clamp(Math.round((z.totalVol / maxZoneVol) * 100), 0, 100);

    let position: PressureZone['position'];
    if (z.highBin < priceBinKey) {
      position = 'support';
    } else if (z.lowBin > priceBinKey) {
      position = 'overhead';
    } else {
      position = 'current';
    }

    return { low, high, totalVolume: z.totalVol, strength, position };
  });

  // ── 6. Score overhead pressure ────────────────────────────────────────────
  const overheadZones = zones.filter(z => z.position === 'overhead' || z.position === 'current');
  const currentZones = zones.filter(z => z.position === 'current');

  // Find nearest overhead zone
  const pureOverhead = zones.filter(z => z.position === 'overhead');
  pureOverhead.sort((a, b) => a.low - b.low); // nearest first
  const nearest = pureOverhead[0] ?? currentZones[0] ?? null;

  let overheadDistancePct = 100;
  if (nearest) {
    if (nearest.position === 'current') {
      overheadDistancePct = 0;
    } else {
      overheadDistancePct = ((nearest.low - price) / price) * 100;
    }
  }

  // Total overhead pressure = weighted sum of overhead zone strengths,
  // decayed by distance (closer zones matter more)
  let overheadPressure = 0;
  for (const z of overheadZones) {
    const zoneMid = (z.low + z.high) / 2;
    const dist = Math.max(0, (zoneMid - price) / price);
    // Decay: zones within 5% get full weight, beyond 20% gets ~20%
    const decay = Math.exp(-dist * 10);
    overheadPressure += z.strength * decay;
  }
  overheadPressure = clamp(Math.round(overheadPressure), 0, 100);

  // ── 7. Composite adjustment ───────────────────────────────────────────────
  let compositeAdjust = 0;
  const details: string[] = [];

  if (currentZones.length > 0) {
    // Price is INSIDE a pressure zone — heavy penalty
    const strongest = Math.max(...currentZones.map(z => z.strength));
    compositeAdjust = -Math.round((strongest / 100) * 20); // -1 to -20
    details.push(`股價在壓力區內(strength=${strongest})`);
  } else if (nearest && nearest.position === 'overhead' && overheadDistancePct < 3) {
    // Approaching overhead zone (< 3%) — strongest penalty
    compositeAdjust = -Math.round((nearest.strength / 100) * 25); // -1 to -25
    details.push(`逼近壓力區${nearest.low.toFixed(1)}-${nearest.high.toFixed(1)}(${overheadDistancePct.toFixed(1)}%)`);
  } else if (nearest && nearest.position === 'overhead' && overheadDistancePct < 5) {
    // Close to overhead (3-5%) — moderate penalty
    compositeAdjust = -Math.round((nearest.strength / 100) * 15); // -1 to -15
    details.push(`接近壓力區${nearest.low.toFixed(1)}-${nearest.high.toFixed(1)}(${overheadDistancePct.toFixed(1)}%)`);
  } else if (nearest && nearest.position === 'overhead' && overheadDistancePct < 10) {
    // Moderate distance to overhead (5-10%)
    compositeAdjust = -Math.round((nearest.strength / 100) * 8); // -1 to -8
    details.push(`上方壓力區${nearest.low.toFixed(1)}-${nearest.high.toFixed(1)}(${overheadDistancePct.toFixed(1)}%)`);
  } else if (overheadZones.length === 0) {
    // No overhead supply — clean air above
    compositeAdjust = 8;
    details.push('上方無壓力區（乾淨空間）');
  } else {
    // Overhead zones exist but far away (>10%)
    compositeAdjust = 3;
    details.push('壓力區距離較遠(>10%)');
  }

  return {
    compositeAdjust: clamp(compositeAdjust, -25, 10),
    overheadPressure,
    nearestOverheadZone: nearest
      ? { low: nearest.low, high: nearest.high, strength: nearest.strength }
      : undefined,
    overheadDistancePct: Math.round(overheadDistancePct * 10) / 10,
    zones,
    detail: details.join('；') || '中性',
  };
}
