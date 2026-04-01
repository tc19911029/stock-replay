/**
 * CapitalSimulator.ts — 回測模式 B：自訂資金完整交易流程型回測
 *
 * 目的：模擬真實資金運作，回答「100萬投入，30天後變多少」
 *
 * 核心邏輯：
 * 1. 每個交易日，用可用資金 + 六條件SOP篩出候選股
 * 2. 用排序因子選出第1名
 * 3. 按部位配置規則計算買入股數
 * 4. 持倉中的股票每日檢查出場條件（朱老師SOP獲利方程式）
 * 5. 出場後資金回到可用池
 * 6. 記錄每筆交易 + 每日權益
 *
 * 四個版本：台股做多、台股做空、陸股做多、陸股做空
 * （做空部分使用 runShortSOPBacktest 邏輯，做多使用 runSOPBacktest 邏輯）
 *
 * 注意：此引擎不呼叫外部API，所有歷史 K 線數據需由呼叫方提供。
 */

import type { MarketId, StockScanResult } from '@/lib/scanner/types';
import type { BacktestTrade, ZhuExitParams } from './BacktestEngine';
import { runSOPBacktest, runShortSOPBacktest, scanResultToSignal, ZHU_PROFIT_FORMULA_STRATEGY, DEFAULT_ZHU_EXIT } from './BacktestEngine';
import { calcRoundTripCost } from './CostModel';
import type { ForwardCandle } from '@/lib/scanner/types';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CapitalSimConfig {
  initialCapital:   number;                       // 初始資金（元），e.g. 1_000_000
  market:           MarketId;
  direction:        'long' | 'short';
  positionMode:     'full' | 'fixed_pct' | 'risk_based';
  positionPct?:     number;                       // fixed_pct 模式 (e.g. 0.5 = 50%)
  maxPositions:     number;                       // 同時最大持倉數 (e.g. 1 or 3)
  rankingFactor:    'composite' | 'surge' | 'smartMoney' | 'histWinRate' | 'sixConditions';
  exitParams?:      Partial<ZhuExitParams>;
  costFeeDiscount?: number;                       // 手續費折扣 (e.g. 0.6 = 六折)
}

export interface CapitalSimDailyRecord {
  date:          string;
  equity:        number;                          // 當日收盤後總資產
  cash:          number;                          // 可用現金
  positionValue: number;                          // 持倉市值
  openPositions: number;                          // 持倉股數
}

export interface CapitalSimTrade extends BacktestTrade {
  positionSizeShares: number;                     // 實際買入股數（張/手）
  positionAmount:     number;                     // 實際投入金額（元）
  pnlAmount:          number;                     // 實際損益金額（元）
}

export interface CapitalSimResult {
  finalCapital:       number;
  totalReturnPct:     number;                     // %
  totalTrades:        number;
  winRate:            number;                     // %
  avgReturn:          number;                     // % per trade
  avgHoldDays:        number;
  maxDrawdown:        number;                     // % (負數)
  profitFactor:       number | null;
  sharpeRatio:        number | null;              // 按日報酬計算
  equityCurve:        CapitalSimDailyRecord[];
  trades:             CapitalSimTrade[];
  skippedCount:       number;
}

// ── 內部持倉記錄 ─────────────────────────────────────────────────────────────

interface OpenPosition {
  symbol:           string;
  name:             string;
  entryDate:        string;
  entryPrice:       number;
  shares:           number;                      // 股數（張/手）
  positionAmount:   number;                      // 投入金額
  forwardCandles:   ForwardCandle[];             // 剩餘前瞻K線（逐日縮短）
  scanResult:       StockScanResult;
  direction:        'long' | 'short';
}

// ── 工具函數 ──────────────────────────────────────────────────────────────────

function calcPositionShares(
  cash:        number,
  price:       number,
  config:      CapitalSimConfig,
): number {
  const unitShares = config.market === 'TW' ? 1000 : 100; // 台股1張=1000股，陸股1手=100股
  let budget = 0;

  if (config.positionMode === 'full') {
    budget = cash;
  } else if (config.positionMode === 'fixed_pct') {
    budget = cash * (config.positionPct ?? 0.5);
  } else {
    // risk_based: 按固定 2% 風險計算（停損5%時，2%帳戶風險 → 持倉40%）
    budget = cash * 0.4;
  }

  const lots = Math.floor(budget / (price * unitShares));
  return Math.max(0, lots);
}

function getFactorScore(result: StockScanResult, factor: CapitalSimConfig['rankingFactor']): number {
  switch (factor) {
    case 'composite':     return result.compositeScore   ?? 0;
    case 'surge':         return result.surgeScore        ?? 0;
    case 'smartMoney':    return result.smartMoneyScore   ?? 0;
    case 'histWinRate':   return result.histWinRate        ?? 0;
    case 'sixConditions': return result.sixConditionsScore;
  }
}

// ── 主引擎 ─────────────────────────────────────────────────────────────────────

/**
 * 執行資金模擬型回測
 *
 * @param config            模擬配置
 * @param dailyScanResults  每天的掃描結果（按日期排序）
 * @param candlesBySymbol   每個股票的完整K線資料（用於計算當日持倉市值）
 * @param forwardBySymbolDate  { symbol_date → ForwardCandle[] }（訊號日後的K線）
 */
export function runCapitalSimulation(
  config:              CapitalSimConfig,
  dailyScanResults:    Array<{ date: string; results: StockScanResult[] }>,
  forwardBySymbolDate: Record<string, ForwardCandle[]>,  // key: `${symbol}_${date}`
): CapitalSimResult {
  let cash             = config.initialCapital;
  const openPositions: OpenPosition[] = [];
  const completedTrades: CapitalSimTrade[] = [];
  const equityCurve:   CapitalSimDailyRecord[] = [];
  let skippedCount     = 0;

  const exitParams: ZhuExitParams = {
    ...DEFAULT_ZHU_EXIT,
    ...config.exitParams,
  };

  const costParams = { twFeeDiscount: config.costFeeDiscount ?? 0.6 };
  const strategy   = { ...ZHU_PROFIT_FORMULA_STRATEGY, costParams };
  const unitShares = config.market === 'TW' ? 1000 : 100;

  // 按日期處理
  const sortedDays = [...dailyScanResults].sort((a, b) => a.date.localeCompare(b.date));

  for (const { date, results } of sortedDays) {
    // ── 1. 現有持倉：嘗試出場（逐日推進K線）──────────────────────────────
    const stillOpen: OpenPosition[] = [];

    for (const pos of openPositions) {
      if (pos.forwardCandles.length === 0) {
        // 無更多K線 → 以最後可用收盤出場
        skippedCount++;
        stillOpen.push(pos);
        continue;
      }

      // 取今日K線（forwardCandles[0] = 進場日後第一根）
      const todayCandle = pos.forwardCandles[0];
      const remainingCandles = pos.forwardCandles.slice(1);

      // 用全部剩餘K線（含今日）重新跑一遍引擎看是否出場
      const signal = scanResultToSignal(pos.scanResult);
      signal.signalDate = pos.entryDate;

      // 注意：這裡傳入剩餘的 forwardCandles（已去掉已處理的日子）
      const trade = pos.direction === 'short'
        ? runShortSOPBacktest(signal, pos.forwardCandles, strategy, exitParams)
        : runSOPBacktest(signal, pos.forwardCandles, strategy, exitParams);

      if (trade && trade.exitDate <= date) {
        // 今天或之前出場
        const exitPrice = trade.exitPrice;
        const gross = pos.direction === 'long'
          ? (exitPrice - pos.entryPrice) * pos.shares * unitShares
          : (pos.entryPrice - exitPrice) * pos.shares * unitShares;

        const cost = calcRoundTripCost(
          config.market, pos.symbol,
          pos.entryPrice * pos.shares * unitShares,
          exitPrice      * pos.shares * unitShares,
          costParams,
        );

        const netPnl    = gross - cost.total;
        const pnlAmount = +netPnl.toFixed(0);
        cash += pos.positionAmount + pnlAmount;

        const simTrade: CapitalSimTrade = {
          ...trade,
          positionSizeShares: pos.shares,
          positionAmount:     pos.positionAmount,
          pnlAmount,
        };
        completedTrades.push(simTrade);
      } else {
        // 尚未出場，更新剩餘K線
        pos.forwardCandles = remainingCandles;
        stillOpen.push(pos);
      }
    }
    openPositions.length = 0;
    openPositions.push(...stillOpen);

    // ── 2. 選新倉（如持倉數 < maxPositions 且有可用資金）─────────────────
    const availableSlots = config.maxPositions - openPositions.length;
    if (availableSlots > 0 && cash > 0 && results.length > 0) {
      // 過濾方向
      const dirResults = config.direction === 'short'
        ? results.filter(r => r.direction === 'short')
        : results.filter(r => !r.direction || r.direction === 'long');

      // 排序
      const ranked = [...dirResults].sort(
        (a, b) => getFactorScore(b, config.rankingFactor) - getFactorScore(a, config.rankingFactor)
      );

      let slotsUsed = 0;
      for (const candidate of ranked) {
        if (slotsUsed >= availableSlots) break;

        const key = `${candidate.symbol}_${date}`;
        const fwdCandles = forwardBySymbolDate[key];
        if (!fwdCandles || fwdCandles.length < 2) {
          skippedCount++;
          continue;
        }

        const entryPrice = fwdCandles[0].open;
        if (!entryPrice || entryPrice <= 0) continue;

        const shares = calcPositionShares(cash / availableSlots, entryPrice, config);
        if (shares <= 0) continue;

        const positionAmount = entryPrice * shares * unitShares;
        if (positionAmount > cash) continue;

        cash -= positionAmount;
        openPositions.push({
          symbol:         candidate.symbol,
          name:           candidate.name,
          entryDate:      date,
          entryPrice,
          shares,
          positionAmount,
          forwardCandles: fwdCandles,
          scanResult:     candidate,
          direction:      config.direction,
        });
        slotsUsed++;
      }
    }

    // ── 3. 計算當日權益 ────────────────────────────────────────────────────
    // 持倉市值：使用今日K線收盤估算（若無則用進場價）
    let positionValue = 0;
    for (const pos of openPositions) {
      const todayClose = pos.forwardCandles[0]?.close ?? pos.entryPrice;
      positionValue += todayClose * pos.shares * unitShares;
    }

    equityCurve.push({
      date,
      equity:        +(cash + positionValue).toFixed(0),
      cash:          +cash.toFixed(0),
      positionValue: +positionValue.toFixed(0),
      openPositions: openPositions.length,
    });
  }

  // ── 強制平倉最後剩餘持倉（以最後可用收盤價計算）──────────────────────────
  for (const pos of openPositions) {
    if (pos.forwardCandles.length === 0) continue;
    const lastCandle = pos.forwardCandles[pos.forwardCandles.length - 1];
    const exitPrice  = lastCandle.close;
    const gross = pos.direction === 'long'
      ? (exitPrice - pos.entryPrice) * pos.shares * unitShares
      : (pos.entryPrice - exitPrice) * pos.shares * unitShares;
    const cost   = calcRoundTripCost(
      config.market, pos.symbol,
      pos.entryPrice * pos.shares * unitShares,
      exitPrice      * pos.shares * unitShares,
      costParams,
    );
    const pnlAmount = +(gross - cost.total).toFixed(0);
    cash += pos.positionAmount + pnlAmount;
  }

  // ── 績效統計 ─────────────────────────────────────────────────────────────
  const finalCapital     = +cash.toFixed(0);
  const totalReturnPct   = +((finalCapital - config.initialCapital) / config.initialCapital * 100).toFixed(2);
  const wins             = completedTrades.filter(t => t.pnlAmount > 0).length;
  const winRate          = completedTrades.length > 0
    ? +(wins / completedTrades.length * 100).toFixed(1)
    : 0;
  const avgReturn        = completedTrades.length > 0
    ? +(completedTrades.reduce((s, t) => s + t.netReturn, 0) / completedTrades.length).toFixed(2)
    : 0;
  const avgHoldDays      = completedTrades.length > 0
    ? +(completedTrades.reduce((s, t) => s + t.holdDays, 0) / completedTrades.length).toFixed(1)
    : 0;

  // 最大回撤：從權益曲線峰值到谷值
  let maxDrawdown = 0;
  let peak = config.initialCapital;
  for (const d of equityCurve) {
    if (d.equity > peak) peak = d.equity;
    const dd = (d.equity - peak) / peak * 100;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // Profit Factor
  const grossProfit = completedTrades.filter(t => t.pnlAmount > 0).reduce((s, t) => s + t.pnlAmount, 0);
  const grossLoss   = Math.abs(completedTrades.filter(t => t.pnlAmount < 0).reduce((s, t) => s + t.pnlAmount, 0));
  const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : null;

  // Sharpe（簡化：用日報酬）
  let sharpeRatio: number | null = null;
  if (equityCurve.length >= 10) {
    const dailyReturns = equityCurve.slice(1).map((d, i) => {
      const prev = equityCurve[i].equity;
      return prev > 0 ? (d.equity - prev) / prev * 100 : 0;
    });
    const mean = dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / dailyReturns.length;
    const std = Math.sqrt(variance);
    sharpeRatio = std > 0 ? +(mean / std * Math.sqrt(252)).toFixed(2) : null;
  }

  return {
    finalCapital,
    totalReturnPct,
    totalTrades:   completedTrades.length,
    winRate,
    avgReturn,
    avgHoldDays:   +avgHoldDays,
    maxDrawdown:   +maxDrawdown.toFixed(2),
    profitFactor,
    sharpeRatio,
    equityCurve,
    trades:        completedTrades,
    skippedCount,
  };
}
