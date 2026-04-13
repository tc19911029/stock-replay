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
  ma:        ConditionResult & { alignment: string };
  position:  ConditionResult & { stage: TrendPosition; deviation: number | null };
  volume:    ConditionResult & { ratio: number | null; threshold: number };
  kbar:      ConditionResult & { type: string; bodyPct: number; closePos: number };
  indicator: ConditionResult & { macd: boolean; kd: boolean; kdK: number | null; macdOSC: number | null };
  totalScore: number; // 0–6
  coreScore:  number; // 0–5（前5個必要條件）
  isCoreReady: boolean; // 前5個全過 = true
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
    // 朱老師用收盤價判斷頭頭高/底底高（不用最高/最低，避免單日恐慌或假突破干擾）
    if (curr.close > prev.close && curr.close > next.close) {
      pivots.push({ index: i, price: curr.close, type: 'high' });
    } else if (curr.close < prev.close && curr.close < next.close) {
      pivots.push({ index: i, price: curr.close, type: 'low' });
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
    // 矛盾型轉折（頭高底低，或頭低底高）
    const contradictoryPivots = (higherHighs && lowerLows) || (lowerHighs && higherLows);
    if (contradictoryPivots) {
      // 若 MA 完全四線多排（5/MA20/MA60全對齊），恐慌性急跌後快速收復，
      // 信任均線結構勝過單一低點的破底（避免漏掉「市場恐慌後反彈」的飆股）
      const strongBullish = ma5 != null && ma20 != null && ma60 != null
        && ma5 > ma20 && ma20 > ma60 && ma20NonDeclining;
      if (strongBullish) return '多頭';
      return '盤整';
    }
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
 * 朱老師六大進場條件（對齊《活用技術分析寶典》p.54 短線做多選股SOP）
 *
 * ① 趨勢條件：日線波浪型態符合「頭頭高、底底高」多頭架構
 * ② 均線條件：MA10、MA20 多頭排列，均線方向向上
 * ③ 股價位置：收盤在 MA10、MA20 之上，判斷初升段/主升段/末升段
 * ④ 成交量：攻擊量 ≥ 前一日 × 1.3（2倍更強）
 * ⑤ 進場K線：價漲、量增、紅K實體棒 > 2%
 * ⑥ 指標參考：MACD 綠柱縮短或紅柱延長；KD 黃金交叉向上多排
 *
 * 重要：條件 1~5 為必要條件，第6個（指標參考）為輔助確認，可後面補上
 */
export function evaluateSixConditions(
  candles: CandleWithIndicators[],
  index: number,
  params?: Partial<StrategyThresholds>,
): SixConditionsResult {
  const kdMax     = params?.kdMaxEntry      ?? 85;
  const devMax    = params?.deviationMax    ?? 0.12;
  const volMin    = params?.volumeRatioMin  ?? 1.3; // 書上p.54：前一日×1.3
  const shadowMax = params?.upperShadowMax  ?? 0.20;

  const c    = candles[index];
  const prev = index > 0 ? candles[index - 1] : null;

  // ─────────────────────────────────────────────────────────────────────────
  // ① 趨勢條件（必要）
  // ─────────────────────────────────────────────────────────────────────────
  const trendState = detectTrend(candles, index);
  const trendPass  = trendState === '多頭';
  const trendDetail = trendState === '多頭'
    ? '✅ 多頭趨勢（頭頭高底底高 + MA5>MA20）'
    : trendState === '空頭'
    ? '❌ 空頭趨勢（頭頭低底底低）—— 不宜做多'
    : '⚠️ 盤整趨勢（方向不明）—— 觀望';

  // ─────────────────────────────────────────────────────────────────────────
  // ③ 股價位置（必要）
  // 書上p.54：股價收盤要在MA10、MA20之上，判斷初升段/主升段/末升段
  // 合格條件（兩種擇一）：
  //   A. 回後漲：近5日曾觸及MA10支撐（回測），今日收盤回站MA5以上
  //   B. 初漲段：MA20乖離 0–devMax（剛站上月線，還沒太貴）
  // ─────────────────────────────────────────────────────────────────────────
  const stage  = detectTrendPosition(candles, index);
  const ma20   = c.ma20;
  const ma10c  = c.ma10;
  const ma20Dev = ma20 && ma20 > 0 ? (c.close - ma20) / ma20 : null;

  // Scenario A：近5日曾回測到MA10附近（低點 ≤ MA10 × 1.03），今日已回站MA5
  // 朱老師：末升段乖離過大不宜追高，即使回測MA10後反彈也不行
  const pulledBackToMA10 = (() => {
    if (!ma10c || !c.ma5) return false;
    if (ma20Dev !== null && ma20Dev >= devMax) return false; // 乖離過大禁追高
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
  // ⑤ 進場K線（必要）
  // 書上p.54：進場K線要價漲、量增、紅K實體棒＞2%
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
  // ② 均線條件（必要）
  // 書上p.54：日線MA10、MA20多頭排列，均線方向向上
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
  // ④ 成交量（書上p.54：攻擊量 ≥ 前一日 × 1.3，2倍更強）
  // 主要判斷：當天量 ≥ 前一日 × 1.3
  // 次要判斷：量縮回檔後量增上漲
  // ─────────────────────────────────────────────────────────────────────────
  const prevDayVol = prev?.volume ?? 0;
  const volVsPrevDay = prevDayVol > 0
    ? +(c.volume / prevDayVol).toFixed(2)
    : null;
  const avgVol5 = c.avgVol5;

  // 主要：當天量 ≥ 前一日 × 1.3（書上原則）
  const attackVolume = volVsPrevDay !== null && volVsPrevDay >= volMin;

  // 次要：「量縮回檔後量增上漲」：前3日量縮（<均量），今日量增 ≥ 前日1.3x
  let isPullbackVol = false;
  if (index >= 3 && avgVol5) {
    const recentVols = [candles[index-1], candles[index-2], candles[index-3]].map(x => x.volume);
    const allLow = recentVols.every(v => v < avgVol5 * 0.9);
    const todayUp = prevDayVol > 0 && c.volume > prevDayVol * 1.3;
    isPullbackVol = allLow && todayUp;
  }

  // 「新鮮信號」過濾：前2日不能已有大量上漲日，避免買到追高的第N棒
  const isFreshSignal = (() => {
    if (index < 2 || !avgVol5) return true;
    const prev1 = candles[index - 1];
    const prev2 = candles[index - 2];
    const prev1BigUp = prev1.volume >= avgVol5 * 1.3 && prev1.close > prev1.open;
    const prev2BigUp = prev2.volume >= avgVol5 * 1.3 && prev2.close > prev2.open;
    return !(prev1BigUp && prev2BigUp);
  })();

  const volumePass = (attackVolume || isPullbackVol) && isFreshSignal;
  const volumeDetail = volVsPrevDay !== null
    ? volumePass
      ? `✅ 成交量 ${volVsPrevDay}x 前日${isPullbackVol ? '（量縮回檔後量增）' : '（攻擊量）'}${volVsPrevDay >= 2 ? '🔥力道強' : ''}`
      : !isFreshSignal
        ? `⚠️ 前2日已連續大量上漲，訊號陳舊（避免追高）`
        : `⚠️ 成交量 ${volVsPrevDay}x 前日（未達${volMin}x基準）`
    : '前日成交量資料不足';

  // ─────────────────────────────────────────────────────────────────────────
  // ⑥ 指標參考（輔助，可後面補上）
  // 書上p.54：MACD 綠柱縮短或紅柱延長；KD 黃金交叉向上多排
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
  // 總分（書上順序：趨勢→均線→位置→成交量→K線→指標）
  // 條件 1~5 為必要，第6個（指標參考）為輔助
  // ─────────────────────────────────────────────────────────────────────────
  const coreConditions = [trendPass, bullishAlign, positionPass, volumePass, kbarPass]; // 必要 1~5
  const coreScore = coreConditions.filter(Boolean).length;
  const isCoreReady = coreScore === 5; // 前5個全過
  const totalScore = coreScore + (indicatorPass ? 1 : 0);

  return {
    trend:     { pass: trendPass,     state: trendState, detail: trendDetail },
    ma:        { pass: bullishAlign,  alignment: maAlignment, detail: maAlignment },
    position:  { pass: positionPass,  stage, deviation: ma20Dev, detail: positionDetail },
    volume:    { pass: volumePass,    ratio: volVsPrevDay, threshold: volMin, detail: volumeDetail },
    kbar:      { pass: kbarPass,      type: kbarType, bodyPct, closePos, detail: kbarType },
    indicator: { pass: indicatorPass, macd: macdBull, kd: kdBull || kdCross, kdK: c.kdK ?? null, macdOSC: c.macdOSC ?? null, detail: indicatorDetail },
    totalScore,
    coreScore,
    isCoreReady,
  };
}
