import { CandleWithIndicators } from '@/types';

/** K棒實體大小（絕對值，百分比） */
export function bodyPct(c: CandleWithIndicators): number {
  return Math.abs(c.close - c.open) / c.open;
}

/** 是否為實體長紅K（實體 ≥ 開盤價2%，且收紅；對齊其他模組） */
export function isLongRedCandle(c: CandleWithIndicators): boolean {
  return c.close > c.open && bodyPct(c) >= 0.02;
}

/** 是否為實體長黑K（實體 ≥ 開盤價2%，且收黑；對齊其他模組） */
export function isLongBlackCandle(c: CandleWithIndicators): boolean {
  return c.close < c.open && bodyPct(c) >= 0.02;
}

/** K棒1/2價（最高+最低）÷2 */
export function halfPrice(c: CandleWithIndicators): number {
  return (c.high + c.low) / 2;
}

/** 計算收盤與MA的乖離率（正=高於MA，負=低於MA） */
export function maDeviation(c: CandleWithIndicators, maKey: 'ma20' | 'ma60'): number | null {
  const ma = c[maKey];
  if (ma == null) return null;
  return (c.close - ma) / ma;
}

/** 判斷最近N根是否為波浪頭頭高（多頭趨勢） */
export function isUptrendWave(candles: CandleWithIndicators[], index: number, lookback = 5): boolean {
  if (index < lookback) return false;
  const slice = candles.slice(index - lookback, index + 1);
  let higherHighs = 0;
  let higherLows  = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i].high > slice[i - 1].high) higherHighs++;
    if (slice[i].low  > slice[i - 1].low)  higherLows++;
  }
  return higherHighs >= 3 && higherLows >= 2;
}

/** 判斷最近N根是否為波浪頭頭低（空頭趨勢） */
export function isDowntrendWave(candles: CandleWithIndicators[], index: number, lookback = 5): boolean {
  if (index < lookback) return false;
  const slice = candles.slice(index - lookback, index + 1);
  let lowerHighs = 0;
  let lowerLows  = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i].high < slice[i - 1].high) lowerHighs++;
    if (slice[i].low  < slice[i - 1].low)  lowerLows++;
  }
  return lowerHighs >= 3 && lowerLows >= 2;
}

// ─── 朱家泓《抓住K線》新增工具函數 ───

/** 是否為小K線（實體 < 1.5%） */
export function isSmallCandle(c: CandleWithIndicators): boolean {
  return bodyPct(c) < 0.015;
}

/** 是否為變盤線/十字線/紡錘線（實體 < 0.5%） */
export function isDoji(c: CandleWithIndicators): boolean {
  return bodyPct(c) < 0.005;
}

/** 是否收紅（收盤 >= 開盤） */
export function isRedCandle(c: CandleWithIndicators): boolean {
  return c.close >= c.open;
}

/** 是否收黑（收盤 < 開盤） */
export function isBlackCandle(c: CandleWithIndicators): boolean {
  return c.close < c.open;
}

/** 上影線長度 */
export function upperShadow(c: CandleWithIndicators): number {
  return c.high - Math.max(c.open, c.close);
}

/** 下影線長度 */
export function lowerShadow(c: CandleWithIndicators): number {
  return Math.min(c.open, c.close) - c.low;
}

/** 實體長度（絕對值） */
export function bodySize(c: CandleWithIndicators): number {
  return Math.abs(c.close - c.open);
}

/** 上影線是否 >= 實體 2 倍 */
export function hasLongUpperShadow(c: CandleWithIndicators): boolean {
  const body = bodySize(c);
  return body > 0 ? upperShadow(c) >= body * 2 : upperShadow(c) > 0;
}

/** 下影線是否 >= 實體 2 倍 */
export function hasLongLowerShadow(c: CandleWithIndicators): boolean {
  const body = bodySize(c);
  return body > 0 ? lowerShadow(c) >= body * 2 : lowerShadow(c) > 0;
}

/** 是否為中長紅K（實體 >= 2%；2026-05-04 從 2.5% 對齊寶典 2024 短線做多 SOP p.55 ⑤） */
export function isMedLongRed(c: CandleWithIndicators): boolean {
  return c.close > c.open && bodyPct(c) >= 0.02;
}

/** 是否為中長黑K（實體 >= 2%；2026-05-04 從 2.5% 對齊寶典 2024） */
export function isMedLongBlack(c: CandleWithIndicators): boolean {
  return c.close < c.open && bodyPct(c) >= 0.02;
}

/** 向上跳空缺口：curr.low > prev.high */
export function gapUp(prev: CandleWithIndicators, curr: CandleWithIndicators): boolean {
  return curr.low > prev.high;
}

/** 向下跳空缺口：curr.high < prev.low */
export function gapDown(prev: CandleWithIndicators, curr: CandleWithIndicators): boolean {
  return curr.high < prev.low;
}

/** 向上跳空缺口的 4 個關鍵價位（朱家泓缺口支撐理論） */
export function gapUpEdges(prev: CandleWithIndicators, curr: CandleWithIndicators): {
  upperHigh: number; upperEdge: number; lowerEdge: number; lowerBottom: number;
} {
  return {
    upperHigh: curr.high,       // 上高價（缺口上方K線最高）
    upperEdge: curr.low,        // 上沿價（缺口上方K線最低）
    lowerEdge: prev.high,       // 下沿價（缺口下方K線最高）
    lowerBottom: prev.low,      // 下底價（缺口下方K線最低）
  };
}

/** 向下跳空缺口的 4 個關鍵價位（朱家泓缺口壓力理論） */
export function gapDownEdges(prev: CandleWithIndicators, curr: CandleWithIndicators): {
  upperHigh: number; upperEdge: number; lowerEdge: number; lowerBottom: number;
} {
  return {
    upperHigh: prev.high,       // 上高價（缺口上方K線最高）
    upperEdge: prev.low,        // 上沿價（缺口上方K線最低）
    lowerEdge: curr.high,       // 下沿價（缺口下方K線最高）
    lowerBottom: curr.low,      // 下底價（缺口下方K線最低）
  };
}

/** N 日累計漲跌幅 */
export function priceChangePercent(candles: CandleWithIndicators[], index: number, days: number): number {
  if (index < days) return 0;
  const startClose = candles[index - days].close;
  return (candles[index].close - startClose) / startClose;
}

/** 判斷上升角度是否 >= 45度（用 N 日價差 vs 時間比例） */
export function isRising45(candles: CandleWithIndicators[], index: number, lookback = 5): boolean {
  if (index < lookback) return false;
  const change = priceChangePercent(candles, index, lookback);
  // 5日漲幅 > 5% 約等同 45度上升（每日1%以上）
  return change > 0.05;
}

/** 判斷下降角度是否 >= 45度 */
export function isFalling45(candles: CandleWithIndicators[], index: number, lookback = 5): boolean {
  if (index < lookback) return false;
  const change = priceChangePercent(candles, index, lookback);
  return change < -0.05;
}

// ─── 朱家泓《抓住線圖 股民變股神》新增工具函數 ─────────────────────────────────

type MaKey = 'ma3' | 'ma5' | 'ma10' | 'ma20' | 'ma24' | 'ma60' | 'ma100';

/** 判斷指定 MA 是否上揚（lookback 根前的 MA < 當前 MA） */
export function isMaTrendingUp(
  candles: CandleWithIndicators[], index: number, maKey: MaKey, lookback = 3,
): boolean {
  if (index < lookback) return false;
  const curr = candles[index][maKey];
  const prev = candles[index - lookback][maKey];
  if (curr == null || prev == null) return false;
  return curr > prev;
}

/** 判斷指定 MA 是否下彎 */
export function isMaTrendingDown(
  candles: CandleWithIndicators[], index: number, maKey: MaKey, lookback = 3,
): boolean {
  if (index < lookback) return false;
  const curr = candles[index][maKey];
  const prev = candles[index - lookback][maKey];
  if (curr == null || prev == null) return false;
  return curr < prev;
}

/** 均線糾結度：ma5/ma10/ma20 之間最大差距佔 ma20 的百分比 */
export function maConvergence(c: CandleWithIndicators): number | null {
  if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return null;
  const max = Math.max(c.ma5, c.ma10, c.ma20);
  const min = Math.min(c.ma5, c.ma10, c.ma20);
  return (max - min) / c.ma20;
}

/** 底底高偵測：lookback 區間內找到至少 2 個 swing low，後者高於前者 */
export function isHigherLow(candles: CandleWithIndicators[], index: number, lookback = 20): boolean {
  if (index < lookback) return false;
  const lows: number[] = [];
  for (let i = index - lookback + 1; i <= index - 1; i++) {
    if (i <= 0 || i >= candles.length - 1) continue;
    if (candles[i].low <= candles[i - 1].low && candles[i].low <= candles[i + 1].low) {
      lows.push(candles[i].low);
    }
  }
  if (lows.length < 2) return false;
  return lows[lows.length - 1] > lows[lows.length - 2];
}

/** 頭頭低偵測：lookback 區間內找到至少 2 個 swing high，後者低於前者 */
export function isLowerHigh(candles: CandleWithIndicators[], index: number, lookback = 20): boolean {
  if (index < lookback) return false;
  const highs: number[] = [];
  for (let i = index - lookback + 1; i <= index - 1; i++) {
    if (i <= 0 || i >= candles.length - 1) continue;
    if (candles[i].high >= candles[i - 1].high && candles[i].high >= candles[i + 1].high) {
      highs.push(candles[i].high);
    }
  }
  if (highs.length < 2) return false;
  return highs[highs.length - 1] < highs[highs.length - 2];
}

/** Fibonacci 回檔水平判斷（返回最接近的 fib 等級） */
export function fibRetracementLevel(
  swingHigh: number, swingLow: number, currentPrice: number,
): { level: number; grade: 'strong' | 'normal' | 'weak' } {
  const range = swingHigh - swingLow;
  if (range <= 0) return { level: 0, grade: 'weak' };
  const retracement = (swingHigh - currentPrice) / range;
  if (retracement <= 0.44) return { level: 0.382, grade: 'strong' };
  if (retracement <= 0.56) return { level: 0.5, grade: 'normal' };
  return { level: 0.618, grade: 'weak' };
}

/** 趨勢斜率（ATR 正規化），> 1.0 約等同 45 度 */
export function trendSlope(candles: CandleWithIndicators[], index: number, lookback = 10): number | null {
  if (index < lookback) return null;
  const c = candles[index];
  const atr = c.atr14;
  if (atr == null || atr === 0) return null;
  const priceChange = c.close - candles[index - lookback].close;
  return priceChange / (lookback * atr);
}

/** 子母線偵測：當前 K 線的高低完全在前一根之內 */
export function isInsideBar(c: CandleWithIndicators, prev: CandleWithIndicators): boolean {
  return c.high <= prev.high && c.low >= prev.low;
}

/** 兩 K 線合併方向判斷：取第 1 天開盤、第 2 天收盤、兩天最高/最低 */
export function mergedCandleDirection(
  prev: CandleWithIndicators, c: CandleWithIndicators,
): 'bullish' | 'bearish' | 'neutral' {
  const mergedOpen = prev.open;
  const mergedClose = c.close;
  const mergedBody = Math.abs(mergedClose - mergedOpen);
  const mergedRange = Math.max(prev.high, c.high) - Math.min(prev.low, c.low);
  if (mergedRange === 0) return 'neutral';
  if (mergedClose > mergedOpen && mergedBody / mergedRange > 0.3) return 'bullish';
  if (mergedClose < mergedOpen && mergedBody / mergedRange > 0.3) return 'bearish';
  return 'neutral';
}

/** 判斷是否在低檔（收盤低於 MA20 的 -10% 或低於 MA60） */
export function isLowPosition(c: CandleWithIndicators): boolean {
  if (c.ma20 != null && c.close < c.ma20 * 0.9) return true;
  if (c.ma60 != null && c.close < c.ma60) return true;
  return false;
}

/** 判斷是否在高檔（收盤高於 MA20 的 +10% 或近20日漲幅>30%） */
export function isHighPosition(c: CandleWithIndicators, candles: CandleWithIndicators[], index: number): boolean {
  if (c.ma20 != null && c.close > c.ma20 * 1.1) return true;
  if (index >= 20) {
    const pct = (c.close - candles[index - 20].close) / candles[index - 20].close;
    if (pct > 0.3) return true;
  }
  return false;
}

/** 找最近 lookback 根內的最高價位（與 indicators.recentHigh 對齊起點 0） */
export function findSwingHigh(candles: CandleWithIndicators[], index: number, lookback = 60): number | null {
  let maxHigh = -Infinity;
  const start = Math.max(0, index - lookback);
  for (let i = start; i < index; i++) {
    if (candles[i].high > maxHigh) maxHigh = candles[i].high;
  }
  return maxHigh === -Infinity ? null : maxHigh;
}

/** 找最近 lookback 根內的最低價位（與 indicators.recentLow 對齊起點 0） */
export function findSwingLow(candles: CandleWithIndicators[], index: number, lookback = 60): number | null {
  let minLow = Infinity;
  const start = Math.max(0, index - lookback);
  for (let i = start; i < index; i++) {
    if (candles[i].low < minLow) minLow = candles[i].low;
  }
  return minLow === Infinity ? null : minLow;
}

// ─── Edwards & Magee 圖表型態工具函數 ─────────────────────────────────────────

export interface SwingPoint {
  idx: number;
  price: number;
}

/**
 * 找出所有局部高點（swing highs）
 * margin: 左右各需 margin 根 K 線較低才算局部高點
 */
export function findSwingHighs(
  candles: CandleWithIndicators[], index: number, lookback = 60, margin = 3,
): SwingPoint[] {
  const points: SwingPoint[] = [];
  const start = Math.max(margin, index - lookback);
  const end = index - margin; // 最近 margin 根無法判斷
  for (let i = start; i <= end; i++) {
    let isSwing = true;
    for (let m = 1; m <= margin; m++) {
      if (candles[i].high <= candles[i - m].high || candles[i].high <= candles[i + m].high) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) points.push({ idx: i, price: candles[i].high });
  }
  return points;
}

/**
 * 找出所有局部低點（swing lows）
 * margin: 左右各需 margin 根 K 線較高才算局部低點
 */
export function findSwingLows(
  candles: CandleWithIndicators[], index: number, lookback = 60, margin = 3,
): SwingPoint[] {
  const points: SwingPoint[] = [];
  const start = Math.max(margin, index - lookback);
  const end = index - margin;
  for (let i = start; i <= end; i++) {
    let isSwing = true;
    for (let m = 1; m <= margin; m++) {
      if (candles[i].low >= candles[i - m].low || candles[i].low >= candles[i + m].low) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) points.push({ idx: i, price: candles[i].low });
  }
  return points;
}

/** 判斷兩個價位是否接近相等（容差 tolerance，預設 3%） */
export function priceNear(a: number, b: number, tolerance = 0.03): boolean {
  if (a === 0 && b === 0) return true;
  const avg = (a + b) / 2;
  return Math.abs(a - b) / avg <= tolerance;
}

/** 簡易線性回歸 */
export function linearRegression(
  points: { x: number; y: number }[],
): { slope: number; intercept: number; r2: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: 0, r2: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n, r2: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const yMean = sumY / n;
  let ssRes = 0, ssTot = 0;
  for (const p of points) {
    const predicted = slope * p.x + intercept;
    ssRes += (p.y - predicted) ** 2;
    ssTot += (p.y - yMean) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

/** 判斷是否為帶量突破（成交量 > avgVol5 * ratio） */
export function isVolumeBreakout(c: CandleWithIndicators, ratio = 1.5): boolean {
  if (c.avgVol5 == null || c.avgVol5 === 0) return false;
  return c.volume > c.avgVol5 * ratio;
}
