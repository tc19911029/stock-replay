/**
 * 高勝率進場 6 位置（書本 Part 12 p.749-754 + Part 2 相關章節）
 *
 * 書本明寫的 6 種做多高勝率位置：
 *   1. 回後買上漲（p.37 ①）     — 由 evaluateSixConditions 的 pulledBackBuy 實作
 *   2. 盤整突破（p.37 ②）        — 由 evaluateSixConditions 的 rangeBreakout 實作
 *   3. 打底第 1 支腳（p.42-45）
 *   4. 打底第 2 支腳 / 黃金右腳（p.45 + Part 7 p.515）
 *   5. 均線糾結突破（Part 4 p.299-303）
 *   6. 假跌破反彈（Part 4 葛蘭碧做多買點③ p.308-309）
 *
 * 本檔實作 3-6 四個 detector。1-2 繼續留在 trendAnalysis.ts 的 evaluateSixConditions。
 *
 * 閾值來源：
 *   - 大量 ≥ 5 日均量 × 2（Part 7 p.487 爆大量定義）
 *   - 攻擊量 ≥ 前日 × 1.3（Part 7 p.488）
 *   - 糾結閾值 3%（書本沒明寫，取 max(MA5,10,20) 相對收盤差 <3%）
 *   - 假跌破窗口 5 天（書本「回檔跌破後很快站回」的「很快」具體化）
 */
import { CandleWithIndicators } from '@/types';
import { detectTrend } from './trendAnalysis';

/**
 * 打底第 1 支腳（Part 2 p.42-45 + Part 7 p.513）
 * 書本：空頭下跌到低檔，出現爆大量（5 日均量×2）的黑K或止跌紅K → 搶反彈進貨量
 */
export function detectDoubleBottomLeg1(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 30) return false;
  const c = candles[index];

  // 空頭趨勢中
  const trend = detectTrend(candles, index);
  if (trend !== '空頭') return false;

  // 當日爆大量（5 日均量 × 2，書本 Part 7 p.487 爆大量定義）
  const avgVol5 = c.avgVol5;
  if (!avgVol5 || avgVol5 <= 0) return false;
  if (c.volume < avgVol5 * 2) return false;

  // 止跌訊號：紅K 或 長下影黑K
  const isRedK = c.close > c.open;
  const bodyAbs = Math.abs(c.close - c.open);
  const lowerShadow = Math.min(c.open, c.close) - c.low;
  return isRedK || lowerShadow > bodyAbs;
}

/**
 * 打底第 2 支腳 / 黃金右腳（Part 2 p.45 + Part 7 p.515）
 * 書本：已有第 1 腳 + 反彈遇壓回檔不破第 1 腳低點 + 大量紅K 上漲
 */
export function detectDoubleBottomLeg2(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 30) return false;
  const c = candles[index];

  // 當日紅K 實體 ≥2%
  if (c.close <= c.open) return false;
  const bodyPct = c.open > 0 ? (c.close - c.open) / c.open : 0;
  if (bodyPct < 0.02) return false;

  // 當日攻擊量（≥ 前日 × 1.3）
  const prev = candles[index - 1];
  if (!prev || prev.volume <= 0) return false;
  if (c.volume < prev.volume * 1.3) return false;

  // 過去 30 天內找第 1 腳（爆量低點）
  let leg1Low: number | null = null;
  for (let j = index - 30; j <= index - 5; j++) {
    if (j < 0) continue;
    const past = candles[j];
    if (!past?.avgVol5 || past.avgVol5 <= 0) continue;
    if (past.volume >= past.avgVol5 * 2 && past.low > 0) {
      if (leg1Low === null || past.low < leg1Low) leg1Low = past.low;
    }
  }
  if (leg1Low === null) return false;

  // 當日 low 不破第 1 腳低點（底底高）
  return c.low > leg1Low;
}

/**
 * 均線糾結突破（Part 4 p.299-303）
 * 書本：3 條均線聚合盤整 → 當日大量紅K 突破
 * 糾結閾值：(max(MA5,10,20) - min) / close < 3%（書本沒明寫具體%，此為合理實作）
 */
export function detectMaClusterBreak(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  const c = candles[index];
  if (c.ma5 == null || c.ma10 == null || c.ma20 == null || c.close <= 0) return false;

  // 當日三線聚合
  const maMax = Math.max(c.ma5, c.ma10, c.ma20);
  const maMin = Math.min(c.ma5, c.ma10, c.ma20);
  if ((maMax - maMin) / c.close >= 0.03) return false;

  // 過去 5 天也聚合（確認是盤整糾結，不是瞬間交叉）
  if (index < 5) return false;
  const prev5 = candles[index - 5];
  if (!prev5?.ma5 || !prev5?.ma10 || !prev5?.ma20 || prev5.close <= 0) return false;
  const prevSpread =
    (Math.max(prev5.ma5, prev5.ma10, prev5.ma20) -
      Math.min(prev5.ma5, prev5.ma10, prev5.ma20)) / prev5.close;
  if (prevSpread >= 0.03) return false;

  // 當日紅K 實體 ≥2%
  if (c.close <= c.open) return false;
  const bodyPct = (c.close - c.open) / c.open;
  if (bodyPct < 0.02) return false;

  // 當日攻擊量（≥ 5 日均量 × 1.3）
  const avgVol5 = c.avgVol5;
  if (!avgVol5 || c.volume < avgVol5 * 1.3) return false;

  // 收盤突破糾結帶上緣
  return c.close > maMax;
}

/**
 * 假跌破反彈（Part 4 葛蘭碧做多買點③ p.308-309）
 * 書本：均線上揚 + 股價回檔跌破均線 + 很快站回 → 買
 * 實作：MA20 上揚 + 近 5 日曾收盤跌破 MA20 + 今日紅K 收盤站回 MA20
 */
export function detectFalseBreakRebound(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 5) return false;
  const c = candles[index];
  const prev = candles[index - 1];
  if (c.ma20 == null || !prev?.ma20) return false;

  // MA20 上揚
  if (c.ma20 <= prev.ma20) return false;

  // 近 5 日曾收盤跌破 MA20
  let wasBroken = false;
  for (let j = Math.max(0, index - 5); j < index; j++) {
    const past = candles[j];
    if (past?.ma20 != null && past.close < past.ma20) { wasBroken = true; break; }
  }
  if (!wasBroken) return false;

  // 今日紅K + 收盤站回 MA20
  return c.close > c.ma20 && c.close > c.open;
}

/**
 * 高勝率 6 位置總判定（p.749-754）
 * 任一位置符合即屬高勝率進場。
 *
 * 位置 1-2（pulledBackBuy, rangeBreakout）在 evaluateSixConditions 已算，
 * 本函式只額外判 3-6 的四個位置。
 */
export function detectExtraHighWinPositions(
  candles: CandleWithIndicators[],
  index: number,
): {
  doubleBottomLeg1: boolean;
  doubleBottomLeg2: boolean;
  maClusterBreak:   boolean;
  falseBreakRebound: boolean;
} {
  return {
    doubleBottomLeg1:  detectDoubleBottomLeg1(candles, index),
    doubleBottomLeg2:  detectDoubleBottomLeg2(candles, index),
    maClusterBreak:    detectMaClusterBreak(candles, index),
    falseBreakRebound: detectFalseBreakRebound(candles, index),
  };
}
