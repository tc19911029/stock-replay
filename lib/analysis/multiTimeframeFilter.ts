/**
 * multiTimeframeFilter.ts — 長線保護短線：多時間框架前置過濾器
 *
 * 來源：
 *   《抓住線圖》戰法1「長線保護短線」
 *   《做對5個實戰步驟》月線→週線→日線 SOP
 *   《活用技術分析寶典》「用週線控管依日線進場的風險」
 *   朱家泓網路實例（伍豐/宣德）確認 MTF 為 checklist 非評分公式
 *
 * 2026-04-20 重寫為 checklist，對齊朱家泓原意
 *
 * 週線 5 項 checklist（朱家泓 MTF 共振條件）：
 *   #1 週線趨勢多頭（頭頭高底底高）
 *   #2 MA5/10/20 三線多排向上
 *   #3 收盤站上 MA60（對應朱家泓 MA65 季線）
 *   #4 MACD 紅柱延長
 *   #5 KD<50 金叉
 *
 * 月線 1 項：
 *   #1 月線趨勢不是空頭（寬鬆）
 */

import type { CandleWithIndicators } from '@/types';
import type { StrategyThresholds } from '@/lib/strategy/StrategyConfig';
import { aggregateCandles } from '@/lib/datasource/aggregateCandles';
import { computeIndicators } from '@/lib/indicators';
import { detectTrend, findPivots, TrendState } from '@/lib/analysis/trendAnalysis';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TimeframeCheckResult {
  timeframe: 'weekly' | 'monthly';
  trend: TrendState;
  pass: boolean;
  score: number;
  detail: string;
}

/**
 * 週線 6 項 = 日線六條件完全複製到週線
 * ① 趨勢多頭 ② 均線多排+向上 ③ 股價位置>MA10/MA20 ④ 攻擊量 ⑤ 紅K實體+高收盤+上影 ⑥ MACD+KD
 */
export interface WeeklyChecks {
  trend: boolean;       // ① 趨勢多頭（頭頭高底底高）
  ma: boolean;          // ② MA5/10/20 三線多排 + MA10/MA20 向上（1根比較）
  position: boolean;    // ③ 收盤 > MA10 AND 收盤 > MA20
  volume: boolean;      // ④ 週量 ≥ 前週 × 1.3
  kbar: boolean;        // ⑤ 紅K實體 ≥ 2% + 高收盤 + 上影 ≤ 實體
  indicator: boolean;   // ⑥ (MACD 綠柱縮小 OR 紅柱延長) AND KD 金叉向上
}

export interface MultiTimeframeResult {
  weekly: TimeframeCheckResult;
  monthly: TimeframeCheckResult;
  weeklyChecks: WeeklyChecks;
  totalScore: number;              // 週0-6 + 月0-1 = 0-7
  pass: boolean;
  weeklyNearResistance: boolean;   // 保留給戒律4使用
  weeklyResistanceDetail?: string;
}

// ── Weekly checks ─────────────────────────────────────────────────────────────

/**
 * 週線 6 項 checklist（= 日線六條件完全複製到週線）
 * ① 趨勢多頭（頭頭高底底高）
 * ② MA5/10/20 三線多排 + MA10/20 向上（1 根比較）
 * ③ 收盤 > MA10 AND MA20
 * ④ 週量 ≥ 前週 × 1.3
 * ⑤ 紅K實體 ≥ 2% + 高收盤 + 上影 ≤ 實體
 * ⑥ (MACD 綠縮 OR 紅延) AND KD 金叉向上
 *
 * 通過條件：①-⑤ 全過（⑥ 加分不當 gate）
 */
function checkWeekly(weeklyCandles: CandleWithIndicators[]): {
  score: number;
  trend: TrendState;
  nearResistance: boolean;
  resistanceDetail?: string;
  detail: string;
  checks: WeeklyChecks;
} {
  const evalIdx = weeklyCandles.length - 2;
  if (evalIdx < 20) {
    return {
      score: 6,
      trend: '盤整',
      nearResistance: false,
      detail: '週線數據不足，跳過檢查',
      checks: { trend: true, ma: true, position: true, volume: true, kbar: true, indicator: true },
    };
  }

  const c = weeklyCandles[evalIdx];
  const prev = weeklyCandles[evalIdx - 1];

  // ── ① 趨勢多頭（頭頭高底底高，用週線）──
  const trend = detectTrend(weeklyCandles, evalIdx);
  const trendPass = trend === '多頭';

  // ── ② MA5/10/20 三線多排 + MA10/MA20 向上（1根比較）──
  let maPass = false;
  const { ma5, ma10, ma20 } = c;
  const prevMa10 = prev?.ma10;
  const prevMa20 = prev?.ma20;
  if (ma5 != null && ma10 != null && ma20 != null) {
    const threeLineBullish = ma5 > ma10 && ma10 > ma20;
    const ma10Rising = prevMa10 != null && ma10 > prevMa10;
    const ma20Rising = prevMa20 != null && ma20 > prevMa20;
    maPass = threeLineBullish && ma10Rising && ma20Rising;
  } else {
    maPass = true;
  }

  // ── ③ 股價位置：close > MA10 AND close > MA20 ──
  const positionPass = (ma10 != null && ma20 != null)
    ? (c.close > ma10 && c.close > ma20)
    : true;

  // ── ④ 攻擊量：週量 ≥ 前週 × 1.3 ──
  const volumePass = prev != null && prev.volume > 0
    ? c.volume >= prev.volume * 1.3
    : true;

  // ── ⑤ 紅K實體 ≥ 2% + 高收盤 + 上影 ≤ 實體 ──
  const bodyPct = c.open > 0 ? (c.close - c.open) / c.open : 0;
  const bodyAbs = Math.abs(c.close - c.open);
  const isRedK = c.close > c.open;
  const isBodyEnough = bodyPct >= 0.02;
  const dayRange = c.high - c.low;
  const closePos = dayRange > 0 ? (c.close - c.low) / dayRange : 0;
  const isHighClose = closePos >= 0.5;
  const upperShadow = c.high - Math.max(c.open, c.close);
  const noLongUpperShadow = upperShadow <= bodyAbs;
  const kbarPass = isRedK && isBodyEnough && isHighClose && noLongUpperShadow;

  // ── ⑥ (MACD 綠柱縮小 OR 紅柱延長) AND KD 金叉向上 ──
  const oscNow = c.macdOSC;
  const oscPrev = prev?.macdOSC;
  let macdOk = true;
  if (oscNow != null && oscPrev != null) {
    const redExtending = oscNow > 0 && oscNow > oscPrev;
    const greenShrinking = oscNow < 0 && oscNow > oscPrev;
    macdOk = redExtending || greenShrinking;
  }
  const kdK = c.kdK;
  const kdD = c.kdD;
  const prevKdK = prev?.kdK;
  const prevKdD = prev?.kdD;
  let kdOk = true;
  if (kdK != null && kdD != null && prevKdK != null && prevKdD != null) {
    kdOk = prevKdK <= prevKdD && kdK > kdD;
  }
  const indicatorPass = macdOk && kdOk;

  // ── 週線壓力區（保留給戒律 4，不算 checklist 項）──
  let nearResistance = false;
  let resistanceDetail: string | undefined;
  const pivots = findPivots(weeklyCandles, evalIdx, 6);
  const swingHighs = pivots
    .filter(p => p.type === 'high')
    .filter(p => p.index < evalIdx - 1);
  for (const sh of swingHighs) {
    if (sh.price <= 0) continue;
    const distPct = (sh.price - c.close) / sh.price;
    if (distPct > 0 && distPct < 0.03) {
      nearResistance = true;
      resistanceDetail = `週收盤 ${c.close.toFixed(2)} 接近前高壓力 ${sh.price.toFixed(2)}（差距 ${(distPct * 100).toFixed(1)}%）`;
      break;
    }
  }

  const checks: WeeklyChecks = {
    trend: trendPass,
    ma: maPass,
    position: positionPass,
    volume: volumePass,
    kbar: kbarPass,
    indicator: indicatorPass,
  };
  const score = (trendPass ? 1 : 0) + (maPass ? 1 : 0) + (positionPass ? 1 : 0)
    + (volumePass ? 1 : 0) + (kbarPass ? 1 : 0) + (indicatorPass ? 1 : 0);

  // 組裝 detail — 週線版六條件（完全對齊日線）
  const items: string[] = [];
  items.push(`①趨勢${trend}${trendPass ? '✅' : '❌'}`);
  items.push(`②均線${maPass ? '✅三線多排+向上' : '❌三線未多排或未向上'}`);
  items.push(`③位置${positionPass ? '✅站上MA10/20' : '❌未站上MA10/20'}`);
  items.push(`④量${volumePass ? '✅≥前週×1.3' : '❌未達前週×1.3'}`);
  items.push(`⑤紅K${kbarPass ? '✅實體≥2%+高收+短上影' : '❌K線不符'}`);
  items.push(`⑥指標${indicatorPass ? '✅MACD+KD齊備' : '❌MACD或KD未齊'}`);

  return {
    score,
    trend,
    nearResistance,
    resistanceDetail,
    detail: items.join('，'),
    checks,
  };
}

// ── Monthly checks ────────────────────────────────────────────────────────────

/**
 * 月線檢查 #4: 趨勢不是空頭
 * 回傳 0-1 分
 */
function checkMonthly(monthlyCandles: CandleWithIndicators[]): {
  score: number;
  trend: TrendState;
  detail: string;
} {
  const evalIdx = monthlyCandles.length - 2;
  if (evalIdx < 5) {
    return {
      score: 1, // 數據不足，不懲罰
      trend: '盤整',
      detail: '月線數據不足，跳過檢查',
    };
  }

  const trend = detectTrend(monthlyCandles, evalIdx);
  const score = trend !== '空頭' ? 1 : 0;

  const c = monthlyCandles[evalIdx];
  const ma5 = c.ma5;
  const parts: string[] = [];

  if (score) {
    parts.push(`月線${trend}`);
    if (ma5 != null && c.close > ma5) parts.push(`站上月MA5(${ma5.toFixed(0)})`);
  } else {
    parts.push('月線空頭');
  }

  return { score, trend, detail: parts.join('，') };
}

// ── P2B: 聚合快取（同一掃描內，相同輸入直接返回）───────────────────────────
// key = `${lastCandleDate}:${candleCount}:${interval}`
// 聚合是確定性的（同輸入 → 同輸出），所以同一批掃描內可安全快取。
// 用 WeakRef 或定期清除避免記憶體洩漏。

const _aggregationCache = new Map<string, CandleWithIndicators[]>();
let _aggregationCacheEpoch = Date.now();

function getCachedAggregation(
  dailyCandles: CandleWithIndicators[],
  interval: '1wk' | '1mo',
): CandleWithIndicators[] {
  // 每 5 分鐘清除快取，避免記憶體洩漏
  const now = Date.now();
  if (now - _aggregationCacheEpoch > 300_000) {
    _aggregationCache.clear();
    _aggregationCacheEpoch = now;
  }

  const last = dailyCandles[dailyCandles.length - 1];
  if (!last) return computeIndicators(aggregateCandles(dailyCandles, interval));

  const key = `${last.date}:${dailyCandles.length}:${interval}`;
  const cached = _aggregationCache.get(key);
  if (cached) return cached;

  const result = computeIndicators(aggregateCandles(dailyCandles, interval));
  _aggregationCache.set(key, result);
  return result;
}

/** 手動清除快取（掃描結束後呼叫） */
export function clearAggregationCache(): void {
  _aggregationCache.clear();
  _aggregationCacheEpoch = Date.now();
}

/**
 * 判斷今日收盤是否接近週線前高壓力（戒律 4 專用）
 * 聚合日 K → 週 K → 找 pivot high → 比較今日 close 距最近的前高
 * @param proximityPct 接近度（預設 0.03 = 3% 以內算接近）
 *                     注：朱家泓書+網路均無「接近%」具體值（只寫「接近壓力必帶量」），3% 為實作自選
 */
export function isNearWeeklyResistance(
  dailyCandles: CandleWithIndicators[],
  proximityPct = 0.03,
): { near: boolean; detail?: string } {
  if (dailyCandles.length < 60) return { near: false };
  const todayClose = dailyCandles[dailyCandles.length - 1].close;

  const weeklyCandles = getCachedAggregation(dailyCandles, '1wk');
  if (weeklyCandles.length < 4) return { near: false };

  // 用最後一根之前的週 K 找 pivot（避免今日所在那根週 K 自己當壓力）
  const evalIdx = weeklyCandles.length - 2;
  const pivots = findPivots(weeklyCandles, evalIdx, 6);
  // 只檢查「最近一個」週線頭（書本：週線最近的頭=壓力）
  const latestHigh = pivots.find(p => p.type === 'high' && p.index < evalIdx - 1);
  if (!latestHigh || latestHigh.price <= 0) return { near: false };

  const distPct = (latestHigh.price - todayClose) / latestHigh.price;
  if (distPct > 0 && distPct < proximityPct) {
    return {
      near: true,
      detail: `週線最近的頭 ${latestHigh.price.toFixed(2)}，今日收盤 ${todayClose.toFixed(2)}（差距 ${(distPct*100).toFixed(1)}%）`,
    };
  }
  return { near: false };
}

// ── Main evaluator ────────────────────────────────────────────────────────────

/**
 * 多時間框架前置過濾器
 *
 * @param dailyCandles 日K資料（含指標），至少需要 60 根以上
 * @param thresholds   策略設定（含 MTF 開關和門檻）
 * @returns MultiTimeframeResult
 */
export function evaluateMultiTimeframe(
  dailyCandles: CandleWithIndicators[],
  thresholds: StrategyThresholds,
): MultiTimeframeResult {
  // P2B: 使用快取的聚合結果（同一掃描內相同輸入直接返回）
  const weeklyCandles = getCachedAggregation(dailyCandles, '1wk');
  const monthlyCandles = getCachedAggregation(dailyCandles, '1mo');

  const weekly = checkWeekly(weeklyCandles);
  const monthly = checkMonthly(monthlyCandles);

  // 通過條件（對齊日線六條件）：
  //   週線前 5 項（①-⑤）全過 = gate
  //   週線第 6 項（⑥ MACD+KD）= 加分非 gate
  //   月線趨勢不空頭 = 加分非 gate（寬鬆模式保留）
  const weeklyCore5Pass =
    weekly.checks.trend &&
    weekly.checks.ma &&
    weekly.checks.position &&
    weekly.checks.volume &&
    weekly.checks.kbar;

  const mtfWeeklyStrict = thresholds.mtfWeeklyStrict ?? true;
  const mtfMonthlyStrict = thresholds.mtfMonthlyStrict ?? false;

  const weeklyPass = mtfWeeklyStrict ? weeklyCore5Pass : true;
  const monthlyPass = mtfMonthlyStrict ? monthly.score >= 1 : true;

  const pass = weeklyPass && monthlyPass;

  const totalScore = weekly.score + monthly.score; // 0-7 僅作 UI 顯示

  return {
    weekly: {
      timeframe: 'weekly',
      trend: weekly.trend,
      pass: weeklyCore5Pass,
      score: weekly.score,
      detail: weekly.detail,
    },
    monthly: {
      timeframe: 'monthly',
      trend: monthly.trend,
      pass: monthly.score >= 1,
      score: monthly.score,
      detail: monthly.detail,
    },
    weeklyChecks: weekly.checks,
    totalScore,
    pass,
    weeklyNearResistance: weekly.nearResistance,
    weeklyResistanceDetail: weekly.resistanceDetail,
  };
}
