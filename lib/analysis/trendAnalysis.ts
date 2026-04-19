import { CandleWithIndicators } from '@/types';
import type { StrategyThresholds } from '@/lib/strategy/StrategyConfig';
import { detectExtraHighWinPositions } from './highWinPositions';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TrendState = '多頭' | '空頭' | '盤整';

export type TrendPosition =
  | '多頭上升段'
  | '末升段(高檔)'
  | '空頭下跌段'
  | '末跌段(低檔)'
  | '盤整觀望'
  // ── 相容舊欄位（歷史 L4 掃描檔會出現）──
  | '起漲段' | '主升段' | '起跌段' | '主跌段';

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
 * 朱家泓《活用技術分析寶典》p.21-22 短線轉折波畫法：
 *   1. 收盤 > MA5 = 正價區；收盤 < MA5 = 負價區
 *   2. 正價區轉負價區（跌破 MA5）：取該段正價區 + 跌破當天的 max(high) = 頭
 *   3. 負價區轉正價區（突破 MA5）：取該段負價區 + 突破當天的 min(low) = 底
 *   4. 高低點按時間連起來 = 短線轉折波
 *
 * 交界當天歸屬於「上一段的尾」，下一段從次日才開始（避免雙算）。
 *
 * @param minSwingPct 保留參數相容，目前算法不使用（交給 MA5 分段自然過濾）
 */
export function findPivots(
  candles: CandleWithIndicators[],
  endIndex: number,
  maxPivots = 10,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  minSwingPct = 0.02,
): Pivot[] {
  const lookback = Math.min(endIndex, 120);
  const start = Math.max(0, endIndex - lookback);

  const pivots: Pivot[] = [];
  let segStart = -1;
  let segType: 'positive' | 'negative' | null = null;

  for (let i = start; i <= endIndex; i++) {
    const c = candles[i];
    if (!c || c.ma5 == null) continue;
    const curr: 'positive' | 'negative' = c.close > c.ma5 ? 'positive' : 'negative';

    if (segType === null) {
      segType = curr;
      segStart = i;
      continue;
    }

    if (curr === segType) continue;

    // 狀態切換：把 [segStart..i] 當成上一段（含交界當天）取極值
    if (segType === 'positive') {
      // 正價區結束 → max(high)
      let bestPrice = -Infinity, bestIdx = segStart;
      for (let j = segStart; j <= i; j++) {
        if (candles[j].high > bestPrice) { bestPrice = candles[j].high; bestIdx = j; }
      }
      pivots.push({ index: bestIdx, price: bestPrice, type: 'high' });
    } else {
      // 負價區結束 → min(low)
      let bestPrice = Infinity, bestIdx = segStart;
      for (let j = segStart; j <= i; j++) {
        if (candles[j].low < bestPrice) { bestPrice = candles[j].low; bestIdx = j; }
      }
      pivots.push({ index: bestIdx, price: bestPrice, type: 'low' });
    }

    // 下一段從次日開始，避免交界當天雙算
    segType = curr;
    segStart = i + 1;
  }

  return pivots.slice(-maxPivots).reverse();
}

// ── Trend detection ───────────────────────────────────────────────────────────

/**
 * 朱老師趨勢判斷（對齊寶典 p.35）：
 *   「由最後一天收盤 K 線往左和最近的「頭」及最近的「底」比較，判定是否符合多頭架構」
 *
 *   多頭 = 頭頭高 + 底底高 同時成立
 *   空頭 = 頭頭低 + 底底低 同時成立
 *   盤整 = 波浪不完整 / 矛盾（頭高底低、頭低底高）/ 轉折中
 *
 * 不再加 MA 粗判或 fallback — 書本只看波浪結構。
 * 波浪由 findPivots (p.22 MA5 分段法) 產出。
 */
export function detectTrend(
  candles: CandleWithIndicators[],
  index: number,
): TrendState {
  if (index < 20) return '盤整';

  const pivots = findPivots(candles, index, 8);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const lows  = pivots.filter(p => p.type === 'low').slice(0, 2);

  // 書本要求同時看到最近兩個頭 + 最近兩個底才能判斷
  if (highs.length < 2 || lows.length < 2) return '盤整';

  const higherHighs = highs[0].price > highs[1].price;
  const higherLows  = lows[0].price  > lows[1].price;
  const lowerHighs  = highs[0].price < highs[1].price;
  const lowerLows   = lows[0].price  < lows[1].price;

  if (higherHighs && higherLows) return '多頭';
  if (lowerHighs  && lowerLows)  return '空頭';
  return '盤整';
}

// ── Trendline (切線) detection — 書本 p.37/p.38 警示用，不做進出場判斷 ───────────

export interface TrendlineInfo {
  /** 線上兩個 pivot 的 index（由舊到新） */
  fromIndex: number;
  toIndex: number;
  fromPrice: number;
  toPrice: number;
  /** 以當前 index 延伸出的線值（今天這條線的價格） */
  todayValue: number;
}

export interface TrendlineWarning {
  /** 下降切線（連兩個頭頭低的頭），無則 null */
  descending: TrendlineInfo | null;
  /** 上升切線（連兩個底底高的底），無則 null */
  ascending: TrendlineInfo | null;
  /** 收盤突破下降切線 → 空頭反彈轉強（p.37 ❶：非做多位置） */
  breakoutBullish: boolean;
  /** 收盤跌破上升切線 → 多頭回檔轉弱（p.38 ❼：非放空位置） */
  breakoutBearish: boolean;
  /** UI 顯示用文字（無警示回空字串） */
  warningText: string;
}

/**
 * 偵測切線突破/跌破（書本 p.37/p.38）。
 *
 * 切線畫法：
 *   - 下降切線 = 最近兩個頭，後頭低於前頭（頭頭低）→ 兩點連直線延伸
 *   - 上升切線 = 最近兩個底，後底高於前底（底底高）→ 兩點連直線延伸
 *
 * 警示訊號：
 *   - 收盤 > 下降切線當日值 → breakoutBullish（空頭轉強警示，非做多位置）
 *   - 收盤 < 上升切線當日值 → breakoutBearish（多頭轉弱警示，非放空位置）
 *
 * 此函式不改變任何進出場決策，只產警示。
 */
export function detectTrendlineBreakout(
  candles: CandleWithIndicators[],
  index: number,
): TrendlineWarning {
  const empty: TrendlineWarning = {
    descending: null, ascending: null,
    breakoutBullish: false, breakoutBearish: false, warningText: '',
  };
  if (index < 2) return empty;

  const pivots = findPivots(candles, index, 8);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const lows  = pivots.filter(p => p.type === 'low').slice(0, 2);

  const close = candles[index].close;

  // 下降切線：highs[1] 較早、highs[0] 較新；若 highs[0] < highs[1] 為頭頭低
  let descending: TrendlineInfo | null = null;
  let breakoutBullish = false;
  if (highs.length === 2 && highs[0].price < highs[1].price) {
    const older = highs[1];  // 較早
    const newer = highs[0];  // 較新
    const slope = (newer.price - older.price) / (newer.index - older.index);
    const todayValue = older.price + slope * (index - older.index);
    descending = {
      fromIndex: older.index, toIndex: newer.index,
      fromPrice: older.price, toPrice: newer.price,
      todayValue,
    };
    breakoutBullish = close > todayValue;
  }

  // 上升切線：lows[1] 較早、lows[0] 較新；若 lows[0] > lows[1] 為底底高
  let ascending: TrendlineInfo | null = null;
  let breakoutBearish = false;
  if (lows.length === 2 && lows[0].price > lows[1].price) {
    const older = lows[1];
    const newer = lows[0];
    const slope = (newer.price - older.price) / (newer.index - older.index);
    const todayValue = older.price + slope * (index - older.index);
    ascending = {
      fromIndex: older.index, toIndex: newer.index,
      fromPrice: older.price, toPrice: newer.price,
      todayValue,
    };
    breakoutBearish = close < todayValue;
  }

  const parts: string[] = [];
  if (breakoutBullish)  parts.push('⚠️ 突破下降切線：空頭反彈轉強訊號（非做多位置）');
  if (breakoutBearish)  parts.push('⚠️ 跌破上升切線：多頭回檔轉弱訊號（非放空位置）');

  return {
    descending, ascending,
    breakoutBullish, breakoutBearish,
    warningText: parts.join('\n'),
  };
}

// ── Position / stage detection ────────────────────────────────────────────────

/**
 * 以「股價距 MA20 的乖離率」判斷目前在哪個位置。
 * 書中核心：「末升段（高檔）乖離過大，不宜追高。」
 *
 * 判斷方式對齊書本 p.45-52 + 朱老師波浪理論實戰觀點：
 *
 *   末升段訊號（任兩項成立 = 末升段，全部書本原文）：
 *     1. 連續 3 根大量長紅 K（p.46 特性 5）
 *     2. 高檔異常爆天量 + 長黑 K（p.50 情境①）
 *     3. 連續 2~3 日爆量後不漲（p.52 情境②）
 *     4. 量價背離（今日創新高但量縮 vs 前波頭）
 *     5. 遛狗理論：MA5 乖離 >15% OR MA20 乖離 >20%（股價遛太遠）
 *
 *   主升段：波數 ≥ 2 但不到末升段（行情已站穩，仍可抱單）
 *   起漲段：波數 < 2（剛突破，風險最小）
 *
 * 空頭方向對稱（用底底低次數判斷）。
 */

function countHeadHighsSinceBottom(pivots: Pivot[]): number {
  // pivots 已 newest-first；從最新往舊數，連續頭頭高的個數
  const highs = pivots.filter(p => p.type === 'high');
  let count = 0;
  for (let i = 0; i < highs.length - 1; i++) {
    if (highs[i].price > highs[i + 1].price) count++;
    else break;
  }
  return count;
}

/** 連續 n 根大量長紅 K（p.46 特性 5：連漲 3 天以上容易賣壓）
 *  「大量」對齊書本 p.54 第 4 條：量 ≥ 前日 × 1.3 */
function hasConsecLongRed(candles: CandleWithIndicators[], index: number, n = 3): boolean {
  if (index < n - 1) return false;
  for (let i = 0; i < n; i++) {
    const c = candles[index - i];
    const p = candles[index - i - 1];
    if (!c || !p) return false;
    const body = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
    const isLongRed = c.close > c.open && body >= 0.02;
    if (!isLongRed) return false;
    // 書本 p.54：量 ≥ 前日 × 1.3
    if (p.volume > 0 && c.volume < p.volume * 1.3) return false;
  }
  return true;
}

/** 高檔異常爆天量 + 長黑 K（p.50 情境①） */
function hasBlowoffBlackReversal(candles: CandleWithIndicators[], index: number): boolean {
  const c = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev) return false;
  // 今日量 ≥ 前日量 × 3
  if (prev.volume <= 0) return false;
  if (c.volume < prev.volume * 3) return false;
  // 今日是長黑 K（實體 ≥ 2%）
  const body = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  const isLongBlack = c.close < c.open && body >= 0.02;
  return isLongBlack;
}

/** 連續 2~3 天爆大量（≥ 5 日均量 × 2）後股價不漲或下跌（p.52 情境②） */
function hasConsecBlowoffNoRise(candles: CandleWithIndicators[], index: number): boolean {
  if (index < 3) return false;
  // 過去 2~3 日皆爆大量
  let blowoffCount = 0;
  for (let i = 1; i <= 3; i++) {
    const c = candles[index - i + 1];  // index..index-2
    if (!c || c.avgVol5 == null) continue;
    if (c.volume >= c.avgVol5 * 2) blowoffCount++;
  }
  if (blowoffCount < 2) return false;
  // 最新 1~2 根不漲（今日或昨日收盤 ≤ 兩天前收盤）
  const c = candles[index];
  const y2 = candles[index - 2];
  if (!c || !y2) return false;
  return c.close <= y2.close;
}

/** 量價背離：今日創近期新高，但今日成交量 < 前一個頭當日成交量（書本「量縮」） */
function hasVolumePriceDivergence(
  candles: CandleWithIndicators[],
  index: number,
  pivots: Pivot[],
): boolean {
  const c = candles[index];
  if (!c) return false;
  const lastHigh = pivots.find(p => p.type === 'high');
  if (!lastHigh) return false;
  const prevHighCandle = candles[lastHigh.index];
  if (!prevHighCandle) return false;
  // 書本：今日創新高（close > 前頭） + 量縮（量 < 前頭量，嚴格比較）
  if (c.close <= lastHigh.price) return false;
  return c.volume < prevHighCandle.volume;
}

/** 遛狗理論：MA5 乖離 >15% OR MA20 乖離 >20%（股價遛太遠，隨時拉回） */
function isBiasOverExtended(candles: CandleWithIndicators[], index: number): boolean {
  const c = candles[index];
  if (!c) return false;
  if (c.ma5 != null && c.ma5 > 0) {
    const ma5Dev = (c.close - c.ma5) / c.ma5;
    if (ma5Dev > 0.15) return true;
  }
  if (c.ma20 != null && c.ma20 > 0) {
    const ma20Dev = (c.close - c.ma20) / c.ma20;
    if (ma20Dev > 0.20) return true;
  }
  return false;
}

export function detectTrendPosition(
  candles: CandleWithIndicators[],
  index: number,
): TrendPosition {
  const trend = detectTrend(candles, index);
  if (trend === '盤整') return '盤整觀望';

  const pivots = findPivots(candles, index, 10);

  if (trend === '多頭') {
    const consecSurge     = hasConsecLongRed(candles, index, 3);
    const blowoffReversal = hasBlowoffBlackReversal(candles, index);
    const blowoffNoRise   = hasConsecBlowoffNoRise(candles, index);
    const volPriceDiv     = hasVolumePriceDivergence(candles, index, pivots);
    const biasOverExt     = isBiasOverExtended(candles, index);

    const endSignals = [
      consecSurge, blowoffReversal, blowoffNoRise, volPriceDiv, biasOverExt,
    ].filter(Boolean).length;
    if (endSignals >= 2) return '末升段(高檔)';
    return '多頭上升段';
  } else {
    // 空頭：對稱判末跌 vs 一般下跌
    const lows = pivots.filter(p => p.type === 'low');
    let lowerLowCount = 0;
    for (let i = 0; i < lows.length - 1; i++) {
      if (lows[i].price < lows[i + 1].price) lowerLowCount++;
      else break;
    }
    if (lowerLowCount >= 5) return '末跌段(低檔)';
    return '空頭下跌段';
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
  const kdMax     = params?.kdMaxEntry      ?? 88;   // 與 BASE_THRESHOLDS 一致
  const devMax    = params?.deviationMax    ?? 0.20; // 與 BASE_THRESHOLDS 一致（20%）
  const volMin    = params?.volumeRatioMin  ?? 1.3;  // 書上p.54：前一日×1.3
  // upperShadowMax 已棄用：書本定義「長上影線 = 上影 > 實體」，不用比例門檻

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

  // 書本 p.37 進場 2 口訣：position gate = 站 MA5 + (回後買上漲 OR 盤整突破)
  // 2026-04-19 用戶決議「按書本走不按回測」，把 pulledBackBuy / rangeBreakout 由 tag 升為 gate
  // pulledBackBuy / rangeBreakout 變數下方定義，此處先佔位，實際在兩者計算後再賦值
  const closeAboveMa5 = c.ma5 != null && c.close > c.ma5;

  // Scenario A：回後買上漲（p.37 ①）— 資訊 tag
  // 書本：上漲一波後的回檔修正不破前低 + 收盤過 MA5 + 收盤過昨日最高點
  // 「回檔修正」→ 用 pivot low 判斷（波浪中曾出現底），不限天數、不限均線
  const pulledBackBuy = (() => {
    if (!c.ma5 || c.close < c.ma5) return false;                 // 收盤站 MA5
    if (!prev || c.close <= prev.high) return false;             // 收盤過昨日最高
    const pivots = findPivots(candles, index, 8);
    const lastLow = pivots.find(p => p.type === 'low');
    if (!lastLow) return false;                                  // 波浪中還沒底，沒回檔
    return c.close > lastLow.price;                              // 今天反攻：收盤高於回檔低點
  })();

  // Scenario B：盤整突破（p.37 ②）— 資訊 tag
  // 書本定義（朱老師心法）：
  //   1. 振幅（箱頂-箱底）/箱底 ≤ 15%
  //   2. 箱頂觸碰 ≥ 2 次 + 箱底觸碰 ≥ 2 次（容錯 2%）
  //   3. 今日收盤突破箱頂
  //
  // 窗口：動態找「最長的連續期間振幅 ≤ 15%」，最小 6 天（書本）
  const rangeBreakout = (() => {
    if (!prev) return false;
    const MIN_DAYS = 6;

    // 從 idx-1 往前擴，找出最長振幅 ≤ 15% 的盤整期
    let rangeHigh = -Infinity, rangeLow = Infinity;
    let windowLen = 0;
    for (let i = index - 1; i >= 0; i--) {
      const h = Math.max(rangeHigh, candles[i].high);
      const l = Math.min(rangeLow,  candles[i].low);
      if (l <= 0) break;
      const amp = (h - l) / l;
      if (amp > 0.15) break;
      rangeHigh = h;
      rangeLow  = l;
      windowLen++;
    }
    if (windowLen < MIN_DAYS) return false;                   // 書本最小窗口 6 天

    // 觸碰次數：至少碰到箱頂 2 次、碰到箱底 2 次
    const topThreshold = rangeHigh * 0.98;
    const botThreshold = rangeLow  * 1.02;
    let topTouches = 0, botTouches = 0;
    for (let i = index - windowLen; i < index; i++) {
      if (candles[i].high >= topThreshold) topTouches++;
      if (candles[i].low  <= botThreshold) botTouches++;
    }
    if (topTouches < 2 || botTouches < 2) return false;

    return c.close > rangeHigh;                               // 突破上頸線
  })();

  // 高勝率 6 位置（書本 Part 12 p.749-754）其餘 4 種
  const extra = detectExtraHighWinPositions(candles, index);

  // 書本 p.37 進場口訣 + p.749-754 高勝率 6 位置
  // positionPass gate：站 MA5 + 至少一個高勝率位置
  const highWinAny =
    pulledBackBuy || rangeBreakout
    || extra.doubleBottomLeg1 || extra.doubleBottomLeg2
    || extra.maClusterBreak   || extra.falseBreakRebound;
  const positionPass = closeAboveMa5 && highWinAny;

  const positionDetail = (() => {
    const devStr = ma20Dev !== null ? `MA20乖離${(ma20Dev*100).toFixed(1)}%` : '';
    if (c.ma5 == null) return '均線資料不足';
    if (!closeAboveMa5) {
      return `❌ 收盤 ${c.close} 未站上 MA5 ${c.ma5.toFixed(1)}`;
    }
    if (!positionPass) {
      return `❌ 站 MA5 但不符 p.749-754 高勝率 6 位置（回後買/盤整突破/打底1腳/打底2腳/均線糾結/假跌破反彈）— ${stage}`;
    }
    const tags: string[] = [];
    if (pulledBackBuy) tags.push('🎯 回後買上漲');
    if (rangeBreakout) tags.push('🎯 盤整突破');
    if (extra.doubleBottomLeg1) tags.push('🎯 打底第1腳');
    if (extra.doubleBottomLeg2) tags.push('🎯 打底第2腳');
    if (extra.maClusterBreak)   tags.push('🎯 均線糾結突破');
    if (extra.falseBreakRebound) tags.push('🎯 假跌破反彈');
    return `✅ ${tags.join(' ')}（${devStr}，${stage}）`;
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
  // 書本定義：長上影線 = 上影線 > 實體（超過實體一倍以上）
  // 上影線長度 = high - max(open, close)
  const upperShadowLen = c.high - Math.max(c.open, c.close);

  const isLongRedK        = isRedK && bodyPct >= 0.02;
  const isHighClose       = closePos >= 0.5;                  // 收在上半段
  const noLongUpperShadow = upperShadowLen <= bodyAbs;         // 上影不超過實體（書本定義）

  const kbarPass = isLongRedK && isHighClose && noLongUpperShadow;
  const kbarType = isLongRedK
    ? kbarPass
      ? `✅ 長紅K（實體${(bodyPct*100).toFixed(1)}%，高收盤 ${(closePos*100).toFixed(0)}%）`
      : `⚠️ 長紅但${!isHighClose ? '收盤偏低' : '長上影線'}（實體${(bodyPct*100).toFixed(1)}%）`
    : isRedK
    ? `⚠️ 小紅K（實體${(bodyPct*100).toFixed(1)}%，未達2%）`
    : `❌ 黑K / 不符合`;

  // ─────────────────────────────────────────────────────────────────────────
  // ② 均線條件（必要）— 書本 Part 2 p.54 第 2 條
  //   原文：「MA10、MA20 多排+向上（季線如果在上方下彎要警示）」
  //   • MA5 > MA10 > MA20 三線多排（MA5 為跨書共識，朱 p.54 只明寫 MA10/MA20）
  //   • MA10/MA20 向上
  //   • MA60 僅作「在上方下彎」壓力警示，不是 gate（書本 p.54）
  //   • p.749 的「突破 60 均 → 4 線多排」是打底完成後升級做長多的條件，非每日進場必要
  // ─────────────────────────────────────────────────────────────────────────
  const { ma5, ma10 } = c;
  const ma60 = c.ma60;
  const prevMa10 = prev?.ma10;
  const prevMa20q = prev?.ma20;
  const prevMa60 = prev?.ma60;

  const maAlign      = ma5 != null && ma10 != null && ma20 != null
    && ma5 > ma10 && ma10 > ma20;                            // 三線多排（對齊 p.54）
  const ma10Rising   = ma10 != null && prevMa10 != null && ma10 > prevMa10;
  const ma20Rising   = ma20 != null && prevMa20q != null && ma20 > prevMa20q;

  const bullishAlign = maAlign && ma10Rising && ma20Rising;

  // MA60 季線壓力警示（書本 p.54 原文「季線如果在上方下彎要警示」，非 gate）
  const ma60Pressure = ma60 != null && prevMa60 != null
    && ma60 > c.close && ma60 < prevMa60;

  const maAlignment = (() => {
    if (bullishAlign) {
      const base = `✅ MA5(${ma5?.toFixed(1)})>MA10(${ma10?.toFixed(1)})>MA20(${ma20?.toFixed(1)}) 三線多排，MA10/20 均向上`;
      return ma60Pressure ? `${base}（⚠️ 季線 ${ma60?.toFixed(1)} 下彎在上方，靠近有壓力）` : base;
    }
    if (ma5 == null || ma10 == null || ma20 == null) return '均線資料不足';
    const issues = [
      !maAlign       ? `⚠️ 三線未完全多排（MA5=${ma5.toFixed(1)} MA10=${ma10.toFixed(1)} MA20=${ma20.toFixed(1)}）` : '',
      !ma10Rising    ? `MA10 未向上(${prevMa10?.toFixed(1)}→${ma10.toFixed(1)})` : '',
      !ma20Rising    ? `MA20 未向上(${prevMa20q?.toFixed(1)}→${ma20.toFixed(1)})` : '',
    ].filter(Boolean).join('，');
    return issues || '均線多排但有問題';
  })();

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
  // 書上p.55：MACD 綠柱縮短或紅柱延長；KD 黃金交叉向上多排
  // 兩者合起來等價於「OSC 數值增加」(osc > oscPrev)
  // ─────────────────────────────────────────────────────────────────────────
  const osc  = c.macdOSC;
  const oscP = prev?.macdOSC;
  const macdBull = osc != null && oscP != null && osc > oscP;

  // 書本 p.54：KD 指標黃金交叉向上多排
  //   = K 值向上（K 今日 > K 昨日）+（黃金交叉 OR 多頭排列）
  const kRising  = c.kdK != null && prev?.kdK != null && c.kdK > prev.kdK;

  // KD 黃金交叉：K 剛剛超過 D
  const kdCross  = prev != null
    && c.kdK != null && c.kdD != null
    && prev.kdK != null && prev.kdD != null
    && c.kdK > c.kdD          // 今日 K > D
    && prev.kdK <= prev.kdD;  // 昨日 K ≤ D（剛交叉）

  // KD 維持多排：K > D 且在健康區間
  const kdBull   = c.kdK != null && c.kdD != null
    && c.kdK > c.kdD
    && c.kdK >= 20
    && c.kdK <= kdMax;

  // 書本要求 K 值向上 + (金叉 OR 多排)
  const kdPass   = kRising && (kdCross || kdBull);

  const indicatorPass = macdBull || kdPass;
  const macdLabel = macdBull
    ? `✅ MACD 轉強(OSC ${oscP?.toFixed(3) ?? '—'}→${osc?.toFixed(3) ?? '—'})`
    : `⚠️ MACD 未轉強(OSC=${osc?.toFixed(3) ?? '—'})`;
  const indicatorDetail = [
    macdLabel,
    kdPass
      ? (kdCross
          ? `✅ KD 金叉+K值向上(K=${c.kdK?.toFixed(0)}↑D=${c.kdD?.toFixed(0)})`
          : `✅ KD 多排+K值向上(K=${c.kdK?.toFixed(0)},D=${c.kdD?.toFixed(0)})`)
      : !kRising
      ? `⚠️ K 值未向上(${prev?.kdK?.toFixed(0) ?? '—'}→${c.kdK?.toFixed(0) ?? '—'})`
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
    indicator: { pass: indicatorPass, macd: macdBull, kd: kdPass, kdK: c.kdK ?? null, macdOSC: c.macdOSC ?? null, detail: indicatorDetail },
    totalScore,
    coreScore,
    isCoreReady,
  };
}
