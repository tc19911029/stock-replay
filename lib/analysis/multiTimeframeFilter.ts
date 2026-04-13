/**
 * multiTimeframeFilter.ts — 長線保護短線：多時間框架前置過濾器
 *
 * 來源：
 *   《抓住線圖》戰法1「長線保護短線」
 *   《做對5個實戰步驟》月線→週線→日線 SOP
 *   《活用技術分析寶典》「用週線控管依日線進場的風險」
 *
 * 在六條件之前，用個股自身的週K/月K判斷長線是否支持做多。
 * 利用現有日K資料本地聚合，不需額外 API 呼叫。
 *
 * 4項檢查（總分 0-4）：
 *   #1 週線趨勢不是空頭                    (1分, 嚴格)
 *   #2 週線MA排列多頭 + 收盤站穩週MA20     (1分, 嚴格)
 *   #3 週線不在前高壓力區                   (1分, 嚴格)
 *   #4 月線趨勢不是空頭                    (1分, 寬鬆)
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

export interface MultiTimeframeResult {
  weekly: TimeframeCheckResult;
  monthly: TimeframeCheckResult;
  totalScore: number;              // 0-4
  pass: boolean;
  weeklyNearResistance: boolean;
  weeklyResistanceDetail?: string;
}

// ── Weekly checks ─────────────────────────────────────────────────────────────

/**
 * 週線檢查 #1: 趨勢不是空頭
 * 週線檢查 #2: MA排列多頭 + 收盤站穩週MA20
 * 週線檢查 #3: 不在前高壓力區
 *
 * 回傳 0-3 分
 */
function checkWeekly(weeklyCandles: CandleWithIndicators[]): {
  score: number;
  trend: TrendState;
  nearResistance: boolean;
  resistanceDetail?: string;
  detail: string;
} {
  // 取倒數第2根（排除未完成的當週）
  const evalIdx = weeklyCandles.length - 2;
  if (evalIdx < 20) {
    return {
      score: 3, // 數據不足，不懲罰（graceful fallback）
      trend: '盤整',
      nearResistance: false,
      detail: '週線數據不足，跳過檢查',
    };
  }

  const c = weeklyCandles[evalIdx];

  // ── #1 週線趨勢 ──
  const trend = detectTrend(weeklyCandles, evalIdx);
  const trendScore = trend !== '空頭' ? 1 : 0;

  // ── #2 MA排列 + 收盤站穩週MA20 ──
  let maScore = 0;
  const ma5 = c.ma5;
  const ma10 = c.ma10;
  const ma20 = c.ma20;

  if (ma5 != null && ma10 != null && ma20 != null) {
    const closeAboveMa20 = c.close > ma20;
    // MA20 方向向上
    const prevMa20 = evalIdx > 0 ? weeklyCandles[evalIdx - 1]?.ma20 : null;
    const ma20Rising = prevMa20 != null && ma20 >= prevMa20;
    // 至少2線多排（MA5 > MA10 or MA10 > MA20）
    const twoLineBullish = (ma5 > ma10) || (ma10 > ma20);

    if (closeAboveMa20 && ma20Rising && twoLineBullish) {
      maScore = 1;
    }
  } else {
    // 指標尚未計算出來（數據不足），不懲罰
    maScore = 1;
  }

  // ── #3 週線壓力區檢查 ──
  // 用 findPivots 找週線前波高點，如果收盤價距任一 swingHigh < 3%，標記壓力區
  let resistanceScore = 1; // 預設通過
  let nearResistance = false;
  let resistanceDetail: string | undefined;

  const pivots = findPivots(weeklyCandles, evalIdx, 6);
  const swingHighs = pivots
    .filter(p => p.type === 'high')
    .filter(p => p.index < evalIdx - 1); // 排除最近1根，避免自己是高點

  for (const sh of swingHighs) {
    if (sh.price <= 0) continue;
    const distPct = (sh.price - c.close) / sh.price;
    // 收盤價接近前高（在前高下方3%以內）且尚未突破
    if (distPct > 0 && distPct < 0.03) {
      resistanceScore = 0;
      nearResistance = true;
      resistanceDetail = `週收盤 ${c.close.toFixed(2)} 接近前高壓力 ${sh.price.toFixed(2)}（差距 ${(distPct * 100).toFixed(1)}%）`;
      break;
    }
  }

  const score = trendScore + maScore + resistanceScore;

  // 組裝 detail
  const parts: string[] = [];
  if (trendScore) parts.push(`週線${trend}`);
  else parts.push(`週線空頭`);
  if (maScore && ma20 != null) parts.push(`站穩週MA20(${ma20.toFixed(0)})`);
  else if (!maScore) parts.push('未站穩週MA20');
  if (nearResistance) parts.push('接近前高壓力');
  else parts.push('無壓力');

  return {
    score,
    trend,
    nearResistance,
    resistanceDetail,
    detail: parts.join('，'),
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

  const totalScore = weekly.score + monthly.score; // 0-4

  // 判斷是否通過
  const mtfWeeklyStrict = thresholds.mtfWeeklyStrict ?? true;
  const mtfMonthlyStrict = thresholds.mtfMonthlyStrict ?? false;
  const mtfMinScore = thresholds.mtfMinScore ?? 2;

  // 嚴格模式：週線任一項不過 → 拒絕
  const weeklyPass = mtfWeeklyStrict ? weekly.score >= 3 : true;
  // 寬鬆模式：月線不過只扣分
  const monthlyPass = mtfMonthlyStrict ? monthly.score >= 1 : true;

  const pass = weeklyPass && monthlyPass && totalScore >= mtfMinScore;

  return {
    weekly: {
      timeframe: 'weekly',
      trend: weekly.trend,
      pass: weekly.score >= 3,
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
    totalScore,
    pass,
    weeklyNearResistance: weekly.nearResistance,
    weeklyResistanceDetail: weekly.resistanceDetail,
  };
}
