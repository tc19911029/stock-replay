import { CandleWithIndicators } from '@/types';
import type { StrategyThresholds } from '@/lib/strategy/StrategyConfig';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TrendState = '多頭' | '空頭' | '盤整';

export type TrendPosition =
  | '起漲段'
  | '主升段'
  | '末升段(高檔)'
  | '起跌段'
  | '主跌段'
  | '末跌段(低檔)'
  | '盤整觀望';

export interface ConditionResult {
  pass: boolean;
  detail: string;
}

export interface SixConditionsResult {
  trend:     ConditionResult & { state: TrendState };
  position:  ConditionResult & { stage: TrendPosition };
  kbar:      ConditionResult & { type: string };
  ma:        ConditionResult & { alignment: string };
  volume:    ConditionResult & { ratio: number | null };
  indicator: ConditionResult & { macd: boolean; kd: boolean };
  totalScore: number; // 0–6
}

// ── Pivot detection ───────────────────────────────────────────────────────────

interface Pivot {
  index: number;
  price: number;
  type: 'high' | 'low';
}

/**
 * Find recent swing highs/lows using a 3-bar comparison.
 * Returns up to `maxPivots` pivots (newest first).
 */
export function findPivots(
  candles: CandleWithIndicators[],
  endIndex: number,
  maxPivots = 10,
): Pivot[] {
  const pivots: Pivot[] = [];
  const lookback = Math.min(endIndex, 120);
  const start = endIndex - lookback;

  for (let i = endIndex - 1; i >= start + 1 && pivots.length < maxPivots; i--) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];
    if (curr.high > prev.high && curr.high > next.high) {
      pivots.push({ index: i, price: curr.high, type: 'high' });
    } else if (curr.low < prev.low && curr.low < next.low) {
      pivots.push({ index: i, price: curr.low, type: 'low' });
    }
  }
  return pivots;
}

// ── Trend detection ───────────────────────────────────────────────────────────

/**
 * 朱老師趨勢判斷：
 *   多頭 = 頭頭高底底高（波浪結構），且 MA5 > MA20
 *   空頭 = 頭頭低底底低（波浪結構），且 MA5 < MA20
 *   盤整 = 方向不明
 */
export function detectTrend(
  candles: CandleWithIndicators[],
  index: number,
): TrendState {
  if (index < 20) return '盤整';
  const c = candles[index];

  const ma5  = c.ma5;
  const ma20 = c.ma20;
  const ma60 = c.ma60;

  if (ma5 == null || ma20 == null) return '盤整';

  // MA20 must be rising or flat (not declining) for a genuine uptrend
  const prevMa20  = index > 0 ? candles[index - 1]?.ma20 : null;
  const ma20NonDeclining = prevMa20 == null || ma20 >= prevMa20 * 0.999;
  const bullishMA = ma5 > ma20 && ma20NonDeclining && (ma60 == null || ma20 > ma60 * 0.97);
  const bearishMA = ma5 < ma20 && (ma60 == null || ma20 < ma60 * 1.03);

  // Confirm with pivot structure
  const pivots = findPivots(candles, index, 8);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 3);
  const lows  = pivots.filter(p => p.type === 'low').slice(0, 3);

  if (highs.length >= 2 && lows.length >= 2) {
    const higherHighs = highs[0].price > highs[1].price;
    const higherLows  = lows[0].price  > lows[1].price;
    const lowerHighs  = highs[0].price < highs[1].price;
    const lowerLows   = lows[0].price  < lows[1].price;

    if (higherHighs && higherLows && bullishMA) return '多頭';
    if (lowerHighs  && lowerLows  && bearishMA) return '空頭';
    // 矛盾型轉折（頭高底低，或頭低底高）才是真正的盤整
    const contradictoryPivots = (higherHighs && lowerLows) || (lowerHighs && higherLows);
    if (contradictoryPivots) return '盤整';
    // 其餘（MA 與轉折方向一致但不夠強）→ 交給下面 MA 判斷
  }

  // Fallback: trust MA alignment alone
  if (bullishMA) return '多頭';
  if (bearishMA) return '空頭';
  return '盤整';
}

// ── Position / stage detection ────────────────────────────────────────────────

/**
 * 以「股價距 MA20 的乖離率」判斷目前在哪個位置。
 * 書中核心：「末升段（高檔）乖離過大，不宜追高。」
 *
 * 多頭位置：
 *   起漲段   = 收盤 > MA20，乖離 0–10%（剛站上月線，風險最小）
 *   主升段   = 乖離 10–20%（行情已走一段，仍可抱單）
 *   末升段   = 乖離 > 20%（乖離過大，禁止追高）
 */
export function detectTrendPosition(
  candles: CandleWithIndicators[],
  index: number,
): TrendPosition {
  const trend = detectTrend(candles, index);
  if (trend === '盤整') return '盤整觀望';

  const c   = candles[index];
  const ma20 = c.ma20;
  const _ma60 = c.ma60;

  if (trend === '多頭') {
    if (!ma20) return '盤整觀望';
    const dev = (c.close - ma20) / ma20;
    if (dev < 0.10)  return '起漲段';
    if (dev < 0.20)  return '主升段';
    return '末升段(高檔)';
  } else {
    // 空頭：用距 MA20 跌幅
    if (!ma20) return '盤整觀望';
    const dev = (ma20 - c.close) / ma20;
    if (dev < 0.10)  return '起跌段';
    if (dev < 0.20)  return '主跌段';
    return '末跌段(低檔)';
  }
}

// ── Six Conditions evaluator ──────────────────────────────────────────────────

/**
 * 朱老師六大進場條件（全面修訂版）
 *
 * ① 趨勢確認：多頭架構（頭頭高底底高 + MA5 > MA20 > MA60）
 * ② 位置合理：乖離 MA20 在 0–15%（起漲段 / 主升段前段）
 * ③ K棒有效：長紅K（實體 ≥ 2%），且收盤在K棒上半段（非長上影線）
 * ④ 均線確認：MA5 > MA10 > MA20，且股價站上5日均線，且 MA5 向上
 * ⑤ 量能配合：成交量 ≥ 5日均量 × 1.5（書中強調帶量）
 * ⑥ 指標輔助：MACD 紅柱，或 KD 黃金交叉（K > D，且 20 ≤ K ≤ 85）
 */
export function evaluateSixConditions(
  candles: CandleWithIndicators[],
  index: number,
  params?: Partial<StrategyThresholds>,
): SixConditionsResult {
  const kdMax     = params?.kdMaxEntry      ?? 85;
  const devMax    = params?.deviationMax    ?? 0.12;
  const volMin    = params?.volumeRatioMin  ?? 1.5;
  const shadowMax = params?.upperShadowMax  ?? 0.20;

  const c    = candles[index];
  const prev = index > 0 ? candles[index - 1] : null;

  // ─────────────────────────────────────────────────────────────────────────
  // ① 趨勢
  // ─────────────────────────────────────────────────────────────────────────
  const trendState = detectTrend(candles, index);
  const trendPass  = trendState === '多頭';
  const trendDetail = trendState === '多頭'
    ? '✅ 多頭趨勢（頭頭高底底高 + MA5>MA20）'
    : trendState === '空頭'
    ? '❌ 空頭趨勢（頭頭低底底低）—— 不宜做多'
    : '⚠️ 盤整趨勢（方向不明）—— 觀望';

  // ─────────────────────────────────────────────────────────────────────────
  // ② 位置
  // 書中林穎SOP：「低檔位置 = 已回測到MA10/MA20支撐區，且量縮回測」
  // 朱老師原則：「乖離過大（>15%）禁止追高；末升段不進場」
  // 合格條件（兩種擇一）：
  //   A. 回後漲：近5日曾觸及MA10支撐（回測），今日收盤回站MA5以上
  //   B. 初漲段：MA20乖離 0–12%（剛站上月線，還沒太貴）
  // ─────────────────────────────────────────────────────────────────────────
  const stage  = detectTrendPosition(candles, index);
  const ma20   = c.ma20;
  const ma10c  = c.ma10;
  const ma20Dev = ma20 && ma20 > 0 ? (c.close - ma20) / ma20 : null;

  // Scenario A：近5日曾回測到MA10附近（低點 ≤ MA10 × 1.03），今日已回站MA5
  const pulledBackToMA10 = (() => {
    if (!ma10c || !c.ma5) return false;
    const aboveMA5Now = c.close >= c.ma5;
    if (!aboveMA5Now) return false;
    for (let i = Math.max(0, index - 5); i < index; i++) {
      const p = candles[i];
      if (p.ma10 && p.low <= p.ma10 * 1.03) return true;
    }
    return false;
  })();

  // Scenario B：初漲段（剛站上月線，乖離 0–devMax）
  const earlyRise = ma20Dev !== null && ma20Dev >= 0 && ma20Dev < devMax;

  const positionPass = pulledBackToMA10 || earlyRise;

  const positionDetail = (() => {
    const devStr = ma20Dev !== null ? `MA20乖離${(ma20Dev*100).toFixed(1)}%` : '';
    if (pulledBackToMA10) return `✅ 回測MA10後翻多（${devStr}，${stage}）`;
    if (earlyRise)        return `✅ 初漲段（${devStr}，${stage}）`;
    if (ma20Dev !== null && ma20Dev >= devMax) return `❌ 乖離過大禁追高（${devStr}）`;
    if (ma20Dev !== null && ma20Dev < 0)     return `⚠️ 低於月線（${devStr}）`;
    return '均線資料不足';
  })();

  // ─────────────────────────────────────────────────────────────────────────
  // ③ K棒
  // 書中：「帶量實體長紅K，且收盤在K棒上半段（非長上影線）」
  // ─────────────────────────────────────────────────────────────────────────
  const bodyAbs   = Math.abs(c.close - c.open);
  const bodyPct   = c.open > 0 ? bodyAbs / c.open : 0;
  const isRedK    = c.close > c.open;
  const dayRange  = c.high - c.low;
  // 收盤在K棒上半段：(close - low)/(high - low) >= 0.5
  const closePos  = dayRange > 0 ? (c.close - c.low) / dayRange : 0.5;
  // 長上影線比例：(high - close)/(high - low)
  const upperShadowRatio = dayRange > 0 ? (c.high - c.close) / dayRange : 0;

  const isLongRedK        = isRedK && bodyPct >= 0.02;
  const isHighClose       = closePos >= 0.5;               // 收在上半段
  const noLongUpperShadow = upperShadowRatio < shadowMax;  // 無長上影線（收盤靠近最高）

  const kbarPass = isLongRedK && isHighClose && noLongUpperShadow;
  const kbarType = isLongRedK
    ? kbarPass
      ? `✅ 長紅K（實體${(bodyPct*100).toFixed(1)}%，高收盤 ${(closePos*100).toFixed(0)}%）`
      : `⚠️ 長紅但${!isHighClose ? '收盤偏低' : '長上影線'}（實體${(bodyPct*100).toFixed(1)}%）`
    : isRedK
    ? `⚠️ 小紅K（實體${(bodyPct*100).toFixed(1)}%，未達2%）`
    : `❌ 黑K / 不符合`;

  // ─────────────────────────────────────────────────────────────────────────
  // ④ 均線多頭排列 + 股價站上5日均線 + MA5 向上
  // 書中：「均線多頭排列向上，股價站上5日均線，是進場的必要條件」
  // ─────────────────────────────────────────────────────────────────────────
  const { ma5, ma10 } = c;
  const prevMa5  = prev?.ma5;
  const prevMa20q = prev?.ma20; // use distinct name to avoid shadowing

  const maFullAlign  = ma5 != null && ma10 != null && ma20 != null
    && ma5 > ma10 && ma10 > ma20;
  const aboveMA5     = ma5 != null && c.close >= ma5;      // 股價站上5日均線
  const ma5Rising    = ma5 != null && prevMa5 != null && ma5 > prevMa5; // MA5 向上
  // MA20 also must not be declining (uptrend confirmation)
  const ma20NonDecl  = ma20 != null && (prevMa20q == null || ma20 >= prevMa20q * 0.999);

  const bullishAlign = maFullAlign && aboveMA5 && ma5Rising && ma20NonDecl;

  const maAlignment = bullishAlign
    ? `✅ MA5(${ma5?.toFixed(1)})>MA10(${ma10?.toFixed(1)})>MA20(${ma20?.toFixed(1)})，MA5向上，收盤站上MA5`
    : ma5 != null && ma10 != null && ma20 != null
    ? [
        !maFullAlign      ? `⚠️ 均線未完整多排` : '',
        !aboveMA5         ? `股價跌破MA5(${ma5.toFixed(1)})` : '',
        !ma5Rising        ? `MA5未向上(${prevMa5?.toFixed(1)}→${ma5.toFixed(1)})` : '',
      ].filter(Boolean).join('，') || '均線多排但有問題'
    : '均線資料不足';

  // ─────────────────────────────────────────────────────────────────────────
  // ⑤ 量能（帶量上漲，書中強調暴大量）
  // 標準：成交量 ≥ 5日均量 × 1.5
  // 回檔後量增也算：前3日量縮，今日量增 ≥ 前日1.3x
  // ─────────────────────────────────────────────────────────────────────────
  const avgVol5 = c.avgVol5;
  const volRatio = avgVol5 && avgVol5 > 0
    ? +(c.volume / avgVol5).toFixed(2)
    : null;

  // 「量縮回檔後量增上漲」：前3日量縮（<均量），今日量增且量比達1.2x以上
  let isPullbackVol = false;
  if (index >= 3 && avgVol5) {
    const recentVols = [candles[index-1], candles[index-2], candles[index-3]].map(x => x.volume);
    const allLow = recentVols.every(v => v < avgVol5 * 0.9);  // 前3日量縮
    const todayUp = index > 0 && c.volume > candles[index-1].volume * 1.3; // 今日量增≥1.3x昨日
    isPullbackVol = allLow && todayUp && (volRatio ?? 0) >= 1.2; // 總量比至少1.2x
  }

  // 「新鮮信號」過濾：前2日不能已有大量上漲日，避免買到追高的第N棒
  const isFreshSignal = (() => {
    if (index < 2 || !avgVol5) return true;
    const prev1 = candles[index - 1];
    const prev2 = candles[index - 2];
    const prev1BigUp = prev1.volume >= avgVol5 * 1.3 && prev1.close > prev1.open;
    const prev2BigUp = prev2.volume >= avgVol5 * 1.3 && prev2.close > prev2.open;
    return !(prev1BigUp && prev2BigUp); // 前2日同時大量上漲才排除（只排除連續追高）
  })();

  const volumePass = ((volRatio !== null && volRatio >= volMin) || isPullbackVol) && isFreshSignal;
  const volumeDetail = volRatio !== null
    ? volumePass
      ? `✅ 成交量 ${volRatio}x 均量${isPullbackVol ? '（量縮回檔後量增）' : '（帶量上漲）'}`
      : !isFreshSignal
        ? `⚠️ 前2日已連續大量上漲，訊號陳舊（避免追高）`
        : `⚠️ 成交量 ${volRatio}x 均量（未達${volMin}x基準）`
    : '5日均量資料不足';

  // ─────────────────────────────────────────────────────────────────────────
  // ⑥ 指標輔助（MACD + KD）
  // KD修正：K>D 且 20≤K≤85（移除原K>50的錯誤限制，加入超買防護）
  // 書中：「KD黃金交叉發生在20-50區間，勝率最高」
  // ─────────────────────────────────────────────────────────────────────────
  const macdBull = c.macdOSC != null && c.macdOSC > 0;

  // KD黃金交叉：K剛剛超過D，且在非超買區（K ≤ 85）
  const kdCross  = prev != null
    && c.kdK != null && c.kdD != null
    && prev.kdK != null && prev.kdD != null
    && c.kdK > c.kdD          // 今日K>D
    && prev.kdK <= prev.kdD;  // 昨日K≤D (黃金交叉剛發生)

  // KD維持多排：K>D 且在健康區間
  const kdBull   = c.kdK != null && c.kdD != null
    && c.kdK > c.kdD
    && c.kdK >= 20             // 不在超賣底部（等待反彈確認）
    && c.kdK <= kdMax;         // 不在超買高點（避免追高）

  const indicatorPass = macdBull || kdBull || kdCross;
  const indicatorDetail = [
    macdBull ? `✅ MACD紅柱(OSC=${c.macdOSC?.toFixed(3)})` : `⚠️ MACD綠柱(${c.macdOSC?.toFixed(3) ?? '—'})`,
    kdCross
      ? `✅ KD黃金交叉(K=${c.kdK?.toFixed(0)}↑D=${c.kdD?.toFixed(0)})`
      : kdBull
      ? `✅ KD多排(K=${c.kdK?.toFixed(0)},D=${c.kdD?.toFixed(0)})`
      : c.kdK != null && c.kdK > kdMax
      ? `❌ KD超買(K=${c.kdK?.toFixed(0)},過高風險大)`
      : `⚠️ KD未多排(K=${c.kdK?.toFixed(0) ?? '—'},D=${c.kdD?.toFixed(0) ?? '—'})`,
  ].join('；');

  // ─────────────────────────────────────────────────────────────────────────
  // 總分
  // ─────────────────────────────────────────────────────────────────────────
  const conditions = [trendPass, positionPass, kbarPass, bullishAlign, volumePass, indicatorPass];
  const totalScore = conditions.filter(Boolean).length;

  return {
    trend:     { pass: trendPass,     state: trendState, detail: trendDetail },
    position:  { pass: positionPass,  stage,             detail: positionDetail },
    kbar:      { pass: kbarPass,      type: kbarType,    detail: kbarType },
    ma:        { pass: bullishAlign,  alignment: maAlignment, detail: maAlignment },
    volume:    { pass: volumePass,    ratio: volRatio,   detail: volumeDetail },
    indicator: { pass: indicatorPass, macd: macdBull, kd: kdBull || kdCross, detail: indicatorDetail },
    totalScore,
  };
}
