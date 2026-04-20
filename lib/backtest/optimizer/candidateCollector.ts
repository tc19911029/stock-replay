/**
 * Candidate Collector — 每日候選股收集器
 *
 * 對每個交易日，掃描所有股票通過 Layer 1-3 篩選，
 * 計算三大排序因子，並預計算 SOP 交易結果。
 *
 * 此為最耗時的步驟（~5 min per market），結果快取後各 Phase 重複使用。
 */

import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { evaluateMultiTimeframe } from '@/lib/analysis/multiTimeframeFilter';
import { evaluateHighWinRateEntry } from '@/lib/analysis/highWinRateEntry';
import { checkLongProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import { simulateTrade } from './tradeSimulator';
import type { CandleWithIndicators, Candle } from '@/types';
import type { MarketId } from '@/lib/scanner/types';
import type { DailyCandidate } from './types';

const thresholds = ZHU_V1.thresholds;

// ── Data Types ──────────────────────────────────────────────────────────────────

export interface CacheData {
  savedAt: string;
  stocks: Record<string, { name: string; candles: Candle[] }>;
}

export interface PreparedData {
  allCandles:   Map<string, { candles: CandleWithIndicators[]; name: string }>;
  tradingDays:  string[];
  market:       MarketId;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function findDateIndex(candles: CandleWithIndicators[], targetDate: string): number {
  for (let i = candles.length - 1; i >= 0; i--) {
    const d = candles[i].date?.slice(0, 10);
    if (d && d <= targetDate) return i;
  }
  return -1;
}

// ── Data Loading ────────────────────────────────────────────────────────────────

/**
 * 載入並準備回測資料
 */
export function loadAndPrepare(
  cacheData:     CacheData,
  benchmarks:    string[],
  market:        MarketId,
  backtestStart: string,
  backtestEnd:   string,
): PreparedData {
  const allCandles = new Map<string, { candles: CandleWithIndicators[]; name: string }>();

  for (const [symbol, data] of Object.entries(cacheData.stocks)) {
    if (data.candles.length >= 60) {
      allCandles.set(symbol, {
        candles: computeIndicators(data.candles),
        name: data.name,
      });
    }
  }

  // 取交易日
  let benchCandles: CandleWithIndicators[] | undefined;
  for (const s of benchmarks) {
    benchCandles = allCandles.get(s)?.candles;
    if (benchCandles && benchCandles.length > 100) break;
  }
  if (!benchCandles) {
    throw new Error('找不到基準股，無法確定交易日');
  }

  const tradingDays = benchCandles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= backtestStart && d <= backtestEnd);

  return { allCandles, tradingDays, market };
}

// ── Main Collection ─────────────────────────────────────────────────────────────

/**
 * 收集所有交易日的候選股（含 SOP 交易模擬）
 *
 * @returns Map<date, DailyCandidate[]> — 每天通過篩選的候選股列表
 */
export function collectAllCandidates(
  data: PreparedData,
): Map<string, DailyCandidate[]> {
  const { allCandles, tradingDays, market } = data;
  const dailyCandidates = new Map<string, DailyCandidate[]>();
  let dayCount = 0;

  for (const date of tradingDays) {
    dayCount++;
    if (dayCount % 20 === 0) {
      console.log(`   處理進度：${dayCount}/${tradingDays.length} 天`);
    }

    const candidates: DailyCandidate[] = [];

    for (const [symbol, stockData] of allCandles) {
      const idx = findDateIndex(stockData.candles, date);
      if (idx < 60) continue;
      if (stockData.candles[idx].date?.slice(0, 10) !== date) continue;

      // ── Layer 1: 六大條件 ──
      const sixConds = evaluateSixConditions(stockData.candles, idx, thresholds);
      if (!sixConds.isCoreReady) continue;

      const last = stockData.candles[idx];

      // ── Layer 1b: KD 向下禁止 ──
      if (last.kdK != null && idx > 0) {
        const prevKdK = stockData.candles[idx - 1]?.kdK;
        if (prevKdK != null && last.kdK < prevKdK) continue;
      }

      // ── Layer 1b: 長上影線禁止（書本定義：上影 > 實體 = 上方賣壓沉重） ──
      const bodyAbs = Math.abs(last.close - last.open);
      const upperShadowLen = last.high - Math.max(last.open, last.close);
      if (bodyAbs > 0 && upperShadowLen > bodyAbs) continue;

      // ── Layer 2: 十大戒律 ──
      const prohib = checkLongProhibitions(stockData.candles, idx);
      if (prohib.prohibited) continue;

      // ── Layer 3: R1-R11 淘汰法 ──
      const elimination = evaluateElimination(stockData.candles, idx);
      if (elimination.eliminated) continue;

      // ── 計算排序因子 ──
      const mtf = evaluateMultiTimeframe(
        stockData.candles.slice(0, idx + 1),
        thresholds,
      );

      let highWinRateScore = 0;
      try {
        highWinRateScore = evaluateHighWinRateEntry(stockData.candles, idx).score;
      } catch { /* skip */ }

      // ── 計算新排序因子（數據驅動）──
      const candles = stockData.candles;
      const entryClose = candles[idx].close;
      const close5ago = idx >= 5 ? candles[idx - 5].close : entryClose;
      const mom5d = +((entryClose / close5ago - 1) * 100).toFixed(2);

      let high60 = -Infinity;
      for (let i = Math.max(0, idx - 59); i <= idx; i++) {
        if (candles[i].high > high60) high60 = candles[i].high;
      }
      const distFrom60dHigh = +((entryClose / high60 - 1) * 100).toFixed(2);

      // ── SOP 交易模擬（陸股用不同出場參數）──
      const marketId = market === 'CN' ? 'CN' as const : 'TW' as const;
      const tradeResult = simulateTrade(
        symbol, stockData.name, market, date,
        sixConds.totalScore, idx, stockData.candles, marketId,
      );

      candidates.push({
        date,
        symbol,
        name: stockData.name,
        market,
        mtfScore:         mtf.totalScore,
        sixCondScore:     sixConds.totalScore,
        highWinRateScore,
        mom5d,
        distFrom60dHigh,
        candleIdx:        idx,
        _stockKey:        symbol,
        tradeResult,
      });
    }

    dailyCandidates.set(date, candidates);
  }

  return dailyCandidates;
}
