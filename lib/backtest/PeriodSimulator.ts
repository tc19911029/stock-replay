/**
 * PeriodSimulator — 期間交易模擬器
 *
 * 在指定日期範圍內，每天自動掃描 → 排序 → 買入 → 按朱老師 SOP 出場 → 賣出後再買。
 * 復用 BacktestEngine 中的 runSOPBacktest / runShortSOPBacktest 出場邏輯。
 */

import type { StockScanResult, ForwardCandle } from '@/lib/scanner/types';
import {
  scanResultToSignal,
  runSOPBacktest,
  runShortSOPBacktest,
  ZHU_PROFIT_FORMULA_STRATEGY,
  DEFAULT_ZHU_EXIT,
  type BacktestTrade,
  type ZhuExitParams,
  type BacktestStrategyParams,
} from './BacktestEngine';
import { calcRoundTripCost, type CostParams } from './CostModel';
import { calcComposite } from '@/features/scan/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export type RankFactor = 'composite' | 'surge' | 'smartMoney' | 'histWinRate' | 'sixConditions';
export type DirectionStrategy = 'longOnly' | 'shortOnly' | 'auto';
export type PositionMode = 'full' | 'fixedPct';

export interface PeriodSimConfig {
  market:            'TW' | 'CN';
  startDate:         string;          // YYYY-MM-DD
  endDate:           string;          // YYYY-MM-DD
  initialCapital:    number;          // 元
  maxPositions:      number;
  positionMode:      PositionMode;
  positionPct:       number;          // e.g. 1.0 = 全倉, 0.5 = 50%
  directionStrategy: DirectionStrategy;
  rankFactor:        RankFactor;
  zhuExit?:          Partial<ZhuExitParams>;
  costFeeDiscount?:  number;          // default 0.6
}

export interface PeriodSimTrade {
  symbol:       string;
  name:         string;
  direction:    'long' | 'short';
  entryDate:    string;
  entryPrice:   number;
  shares:       number;
  entryAmount:  number;
  exitDate:     string | null;
  exitPrice:    number | null;
  exitAmount:   number | null;
  netReturn:    number | null;        // %
  exitReason:   string | null;
  rankAtEntry:  number;               // 排名 (1-based)
}

export interface PeriodSimOperation {
  date:      string;
  action:    'buy' | 'sell';
  symbol:    string;
  name:      string;
  price:     number;
  shares:    number;
  amount:    number;
  reason:    string;
  direction: 'long' | 'short';
}

export interface PeriodSimDailyState {
  date:           string;
  cash:           number;
  positionValue:  number;
  equity:         number;
  openPositions:  number;
  holdings:       Array<{ symbol: string; name: string; shares: number; currentPrice: number }>;
}

export interface PeriodSimResult {
  config:          PeriodSimConfig;
  initialCapital:  number;
  finalCapital:    number;
  totalReturnPct:  number;
  totalTrades:     number;
  winCount:        number;
  winRate:         number;
  maxDrawdown:     number;
  tradingDays:     number;
  operations:      PeriodSimOperation[];
  trades:          PeriodSimTrade[];
  dailyStates:     PeriodSimDailyState[];
}

// ─── Internals ───────────────────────────────────────────────────────────────

interface OpenPosition {
  symbol:         string;
  name:           string;
  direction:      'long' | 'short';
  entryDate:      string;
  entryPrice:     number;
  shares:         number;
  entryAmount:    number;
  rankAtEntry:    number;
  forwardCandles: ForwardCandle[];
  candleIdx:      number;             // how many candles consumed
}

function getRankValue(r: StockScanResult, factor: RankFactor): number {
  switch (factor) {
    case 'composite':     return calcComposite(r);
    case 'surge':         return r.surgeScore ?? 0;
    case 'smartMoney':    return r.smartMoneyScore ?? 0;
    case 'histWinRate':   return r.histWinRate ?? 0;
    case 'sixConditions': return r.sixConditionsScore ?? 0;
  }
}

function calcShares(budget: number, price: number, market: 'TW' | 'CN'): number {
  const lotSize = market === 'TW' ? 1000 : 100;
  const lots = Math.floor(budget / (price * lotSize));
  return lots * lotSize;
}

// ─── Main Simulator ──────────────────────────────────────────────────────────

/**
 * 執行期間模擬。
 *
 * @param config         模擬設定
 * @param dailyScanData  每天的掃描結果 { date, results }（已排好日期）
 * @param forwardMap     每檔股票的 K 線資料 { [symbol]: ForwardCandle[] }
 */
export function runPeriodSimulation(
  config: PeriodSimConfig,
  dailyScanData: Array<{ date: string; results: StockScanResult[] }>,
  forwardMap: Record<string, ForwardCandle[]>,
): PeriodSimResult {
  const {
    market,
    initialCapital,
    maxPositions,
    positionMode,
    positionPct,
    directionStrategy,
    rankFactor,
    costFeeDiscount = 0.6,
  } = config;

  const zhuExit: ZhuExitParams = { ...DEFAULT_ZHU_EXIT, ...config.zhuExit };
  const strategy: BacktestStrategyParams = {
    ...ZHU_PROFIT_FORMULA_STRATEGY,
    costParams: { twFeeDiscount: costFeeDiscount },
  };
  const costParams: CostParams = { twFeeDiscount: costFeeDiscount };

  let cash = initialCapital;
  const openPositions: OpenPosition[] = [];
  const closedTrades: PeriodSimTrade[] = [];
  const operations: PeriodSimOperation[] = [];
  const dailyStates: PeriodSimDailyState[] = [];

  let peakEquity = initialCapital;
  let maxDrawdown = 0;

  // Sort scan data by date
  const sortedDays = [...dailyScanData].sort((a, b) => a.date.localeCompare(b.date));

  // Collect all unique trading dates from forward candles
  const allTradingDates = new Set<string>();
  for (const candles of Object.values(forwardMap)) {
    for (const c of candles) allTradingDates.add(c.date);
  }
  for (const d of sortedDays) allTradingDates.add(d.date);
  const tradingDates = [...allTradingDates]
    .filter(d => d >= config.startDate && d <= config.endDate)
    .sort();

  const scanDataByDate = new Map(sortedDays.map(d => [d.date, d.results]));

  for (const today of tradingDates) {
    // ── Step 1: Check exits for open positions ──
    const toClose: number[] = [];

    for (let i = 0; i < openPositions.length; i++) {
      const pos = openPositions[i];
      const candles = forwardMap[pos.symbol];
      if (!candles) { toClose.push(i); continue; }

      // Find today's candle
      const todayIdx = candles.findIndex(c => c.date === today);
      if (todayIdx < 0) continue; // no data for today

      // Build remaining candles for SOP exit check
      const remainingCandles = candles.slice(pos.candleIdx);
      if (remainingCandles.length === 0) { toClose.push(i); continue; }

      // Check if SOP would have exited by now
      const signal = {
        symbol: pos.symbol,
        name: pos.name,
        market,
        signalDate: pos.entryDate,
        signalScore: 4,
        signalReasons: [],
        trendState: '',
        trendPosition: '',
        direction: pos.direction,
      };

      const backtestResult = pos.direction === 'short'
        ? runShortSOPBacktest(signal, remainingCandles, strategy, zhuExit)
        : runSOPBacktest(signal, remainingCandles, strategy, zhuExit);

      if (backtestResult && backtestResult.exitDate <= today) {
        // Position should exit
        const exitPrice = backtestResult.exitPrice;
        const exitAmount = pos.direction === 'short'
          ? pos.entryAmount + (pos.entryPrice - exitPrice) * pos.shares
          : exitPrice * pos.shares;

        const costs = calcRoundTripCost(
          market, pos.symbol,
          pos.entryAmount,
          Math.abs(exitAmount),
          costParams,
        );

        const netAmount = exitAmount - costs.total;
        cash += netAmount;

        const netReturn = pos.direction === 'short'
          ? ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100 - costs.roundTripPct
          : ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100 - costs.roundTripPct;

        closedTrades.push({
          symbol: pos.symbol,
          name: pos.name,
          direction: pos.direction,
          entryDate: pos.entryDate,
          entryPrice: pos.entryPrice,
          shares: pos.shares,
          entryAmount: pos.entryAmount,
          exitDate: backtestResult.exitDate,
          exitPrice,
          exitAmount: netAmount,
          netReturn,
          exitReason: backtestResult.exitReason,
          rankAtEntry: pos.rankAtEntry,
        });

        operations.push({
          date: backtestResult.exitDate,
          action: 'sell',
          symbol: pos.symbol,
          name: pos.name,
          price: exitPrice,
          shares: pos.shares,
          amount: netAmount,
          reason: backtestResult.exitReason,
          direction: pos.direction,
        });

        toClose.push(i);
      } else {
        // Update candle index to advance day
        const newIdx = candles.findIndex(c => c.date > today);
        if (newIdx > 0) pos.candleIdx = newIdx;
        else if (todayIdx >= 0) pos.candleIdx = todayIdx + 1;
      }
    }

    // Close positions (reverse order to keep indices valid)
    for (const idx of toClose.sort((a, b) => b - a)) {
      openPositions.splice(idx, 1);
    }

    // ── Step 2: Open new positions if slots available ──
    const scanResults = scanDataByDate.get(today);
    if (scanResults && openPositions.length < maxPositions && cash > 0) {
      // Filter by direction strategy
      let candidates = scanResults.filter(r => {
        if (directionStrategy === 'longOnly') return r.direction !== 'short';
        if (directionStrategy === 'shortOnly') return r.direction === 'short';
        return true; // auto
      });

      // Filter out already-held symbols
      const heldSymbols = new Set(openPositions.map(p => p.symbol));
      candidates = candidates.filter(r => !heldSymbols.has(r.symbol));

      // Sort by ranking factor
      candidates.sort((a, b) => getRankValue(b, rankFactor) - getRankValue(a, rankFactor));

      let rank = 0;
      for (const candidate of candidates) {
        if (openPositions.length >= maxPositions) break;
        if (cash <= 0) break;

        rank++;
        const direction = candidate.direction === 'short' ? 'short' as const : 'long' as const;

        // Get next-day open as entry price
        const candles = forwardMap[candidate.symbol];
        if (!candles) continue;

        const todayIdx = candles.findIndex(c => c.date === today);
        if (todayIdx < 0 || todayIdx + 1 >= candles.length) continue;

        const nextCandle = candles[todayIdx + 1];
        const entryPrice = nextCandle.open;
        if (!entryPrice || entryPrice <= 0) continue;

        // Calculate position size
        const budget = positionMode === 'full'
          ? cash * positionPct
          : cash * positionPct;

        const shares = calcShares(budget, entryPrice, market);
        if (shares <= 0) continue;

        const entryAmount = entryPrice * shares;
        if (entryAmount > cash) continue;

        // Deduct cash
        const buyCost = entryAmount * (market === 'TW' ? 0.001425 * costFeeDiscount : 0.0003);
        cash -= (entryAmount + buyCost);

        openPositions.push({
          symbol: candidate.symbol,
          name: candidate.name,
          direction,
          entryDate: nextCandle.date,
          entryPrice,
          shares,
          entryAmount,
          rankAtEntry: rank,
          forwardCandles: candles,
          candleIdx: todayIdx + 2, // start checking from day after entry
        });

        operations.push({
          date: nextCandle.date,
          action: 'buy',
          symbol: candidate.symbol,
          name: candidate.name,
          price: entryPrice,
          shares,
          amount: entryAmount,
          reason: `排名#${rank}（${rankFactor}）`,
          direction,
        });
      }
    }

    // ── Step 3: Record daily state ──
    let positionValue = 0;
    const holdings: PeriodSimDailyState['holdings'] = [];

    for (const pos of openPositions) {
      const candles = forwardMap[pos.symbol];
      if (!candles) continue;
      const todayCandle = candles.find(c => c.date === today) ?? candles[Math.min(pos.candleIdx - 1, candles.length - 1)];
      if (!todayCandle) continue;

      const currentPrice = todayCandle.close;
      const value = pos.direction === 'short'
        ? pos.entryAmount + (pos.entryPrice - currentPrice) * pos.shares
        : currentPrice * pos.shares;

      positionValue += value;
      holdings.push({ symbol: pos.symbol, name: pos.name, shares: pos.shares, currentPrice });
    }

    const equity = cash + positionValue;
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? ((equity - peakEquity) / peakEquity) * 100 : 0;
    if (dd < maxDrawdown) maxDrawdown = dd;

    dailyStates.push({
      date: today,
      cash,
      positionValue,
      equity,
      openPositions: openPositions.length,
      holdings,
    });
  }

  // ── Force close remaining positions at end ──
  for (const pos of openPositions) {
    const candles = forwardMap[pos.symbol];
    const lastCandle = candles?.[candles.length - 1];
    const exitPrice = lastCandle?.close ?? pos.entryPrice;
    const exitDate = lastCandle?.date ?? config.endDate;

    const exitAmount = pos.direction === 'short'
      ? pos.entryAmount + (pos.entryPrice - exitPrice) * pos.shares
      : exitPrice * pos.shares;

    const costs = calcRoundTripCost(market, pos.symbol, pos.entryAmount, Math.abs(exitAmount), costParams);
    const netAmount = exitAmount - costs.total;
    cash += netAmount;

    const netReturn = pos.direction === 'short'
      ? ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100 - costs.roundTripPct
      : ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100 - costs.roundTripPct;

    closedTrades.push({
      symbol: pos.symbol,
      name: pos.name,
      direction: pos.direction,
      entryDate: pos.entryDate,
      entryPrice: pos.entryPrice,
      shares: pos.shares,
      entryAmount: pos.entryAmount,
      exitDate,
      exitPrice,
      exitAmount: netAmount,
      netReturn,
      exitReason: '期末清倉',
      rankAtEntry: pos.rankAtEntry,
    });

    operations.push({
      date: exitDate,
      action: 'sell',
      symbol: pos.symbol,
      name: pos.name,
      price: exitPrice,
      shares: pos.shares,
      amount: netAmount,
      reason: '期末清倉',
      direction: pos.direction,
    });
  }

  // ── Calculate summary ──
  const finalCapital = cash;
  const winCount = closedTrades.filter(t => (t.netReturn ?? 0) > 0).length;

  return {
    config,
    initialCapital,
    finalCapital,
    totalReturnPct: ((finalCapital - initialCapital) / initialCapital) * 100,
    totalTrades: closedTrades.length,
    winCount,
    winRate: closedTrades.length > 0 ? (winCount / closedTrades.length) * 100 : 0,
    maxDrawdown,
    tradingDays: tradingDates.length,
    operations: operations.sort((a, b) => a.date.localeCompare(b.date)),
    trades: closedTrades,
    dailyStates,
  };
}
