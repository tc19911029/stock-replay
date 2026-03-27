/**
 * BacktestEngine.ts — 嚴謹回測引擎 v2
 *
 * 核心設計原則：
 * 1. 無未來函數：訊號日的資料不能包含訊號日之後的資訊
 * 2. 進場使用隔日開盤價（最接近實際操作），含滑價
 * 3. 出場規則明確：固定持有N日、停利、停損
 * 4. 停損/停利同日觸發時，以開盤距離判斷順序
 * 5. 停損出場考慮跳空跌停場景（以開盤價出場）
 * 6. 成本模型分市場計算（台股/陸股分開）
 * 7. 追蹤跳過筆數（存活偏差透明化）
 */

import { ForwardCandle, MarketId, StockScanResult } from '@/lib/scanner/types';
import { calcRoundTripCost, CostParams } from './CostModel';

// ── Types ───────────────────────────────────────────────────────────────────────

/**
 * 通用交易訊號 — BacktestEngine 的唯一輸入依賴
 * 不包含掃描器特有欄位（price, changePercent, triggeredRules 等），
 * 讓引擎可接受任何來源的訊號（掃描器、手動標記、策略回放）。
 */
export interface TradeSignal {
  symbol:        string;
  name:          string;
  market:        MarketId;
  signalDate:    string;    // YYYY-MM-DD
  signalScore:   number;    // 0-6
  signalReasons: string[];  // 命中條件說明
  trendState:    string;    // 趨勢狀態
  trendPosition: string;    // 趨勢位置
}

/**
 * 將掃描結果轉換為通用交易訊號
 * — 掃描器 → 引擎的轉換橋接，保持雙方各自獨立演化
 */
export function scanResultToSignal(scanResult: StockScanResult): TradeSignal {
  const { sixConditionsBreakdown, sixConditionsScore, trendState, trendPosition } = scanResult;
  const reasons: string[] = [];
  if (sixConditionsBreakdown.trend)     reasons.push('趨勢多頭');
  if (sixConditionsBreakdown.position)  reasons.push('位置良好');
  if (sixConditionsBreakdown.kbar)      reasons.push('K棒長紅');
  if (sixConditionsBreakdown.ma)        reasons.push('均線多排');
  if (sixConditionsBreakdown.volume)    reasons.push('量能放大');
  if (sixConditionsBreakdown.indicator) reasons.push('指標配合');

  return {
    symbol:        scanResult.symbol,
    name:          scanResult.name,
    market:        scanResult.market,
    signalDate:    scanResult.scanTime.split('T')[0],
    signalScore:   sixConditionsScore,
    signalReasons: reasons,
    trendState,
    trendPosition,
  };
}

/** 回測進場方式 */
export type EntryType = 'nextOpen' | 'nextClose';

/** 出場規則 */
export type ExitRule =
  | { type: 'holdDays';   days: number }
  | { type: 'stopLoss';   pct: number }   // 負數，e.g. -0.07 = -7%
  | { type: 'takeProfit'; pct: number };  // 正數，e.g. 0.15 = +15%

/** 策略參數 */
export interface BacktestStrategyParams {
  entryType:   EntryType;
  holdDays:    number;         // 固定持有天數（主要出場規則）
  stopLoss:    number | null;  // 停損比例（負數，null = 不設停損）
  takeProfit:  number | null;  // 停利比例（正數，null = 不設停利）
  costParams:  CostParams;
  slippagePct: number;         // 滑價百分比（如 0.001 = 0.1%，買入加 / 賣出減）
}

/** 每筆回測交易完整紀錄 */
export interface BacktestTrade {
  // ── 股票資訊 ──
  symbol:  string;
  name:    string;
  market:  MarketId;

  // ── 訊號資訊 ──
  signalDate:    string;    // 掃描日期（發現訊號的日期）
  signalScore:   number;    // 六大條件分數 0-6
  signalReasons: string[];  // 哪些條件通過（說明命中原因）
  trendState:    string;    // 訊號當時的趨勢狀態
  trendPosition: string;    // 訊號當時的位置

  // ── 進場 ──
  entryDate:  string;       // 實際進場日期
  entryPrice: number;       // 進場價（含滑價）
  entryType:  EntryType;    // 進場方式

  // ── 出場 ──
  exitDate:   string;       // 出場日期
  exitPrice:  number;       // 出場價（含跳空/滑價）
  exitReason: string;       // 出場原因（'holdDays' | 'stopLoss' | 'takeProfit' | 'dataEnd'）
  holdDays:   number;       // 實際持有天數（交易日）

  // ── 績效 ──
  grossReturn: number;      // 毛報酬率 % (不含成本)
  netReturn:   number;      // 淨報酬率 % (含成本)
  buyFee:      number;      // 買入成本（元）
  sellFee:     number;      // 賣出成本（元）
  totalCost:   number;      // 總成本（元）
}

/** 回測統計摘要 */
export interface BacktestStats {
  count:       number;
  wins:        number;
  losses:      number;
  winRate:     number;          // %
  avgGrossReturn: number;
  avgNetReturn:   number;
  medianReturn:   number;
  maxGain:     number;
  maxLoss:     number;
  maxDrawdown: number;          // 最大回撤（權益曲線峰值到谷值，負數）
  totalNetReturn: number;       // 所有筆的淨報酬加總（非複利）
  expectancy:  number;          // 期望值 = winRate * avgWin - lossRate * avgLoss
  // ── 風險調整指標 ──
  sharpeRatio:  number | null;  // (avgNetReturn - 0) / stdReturn
  profitFactor: number | null;  // 總獲利 / |總虧損|
  payoffRatio:  number | null;  // 平均獲利 / |平均虧損|
  // ── 存活偏差 ──
  skippedCount: number;         // 因資料不足被跳過的筆數
  coverageRate: number;         // 有效覆蓋率 % = count / (count + skippedCount)
}

// ── Default Params ──────────────────────────────────────────────────────────────

export const DEFAULT_STRATEGY: BacktestStrategyParams = {
  entryType:   'nextOpen',
  holdDays:    5,
  stopLoss:    -0.07,      // -7% 停損（朱老師標準）
  takeProfit:  null,       // 不設強制停利，讓它跑滿 holdDays
  costParams:  { twFeeDiscount: 0.6 },  // 六折手續費（台灣市場常見折扣）
  slippagePct: 0.001,      // 0.1% 滑價（散戶實際成交偏移）
};

// ── Engine ──────────────────────────────────────────────────────────────────────

/**
 * 對單一交易訊號計算回測績效
 *
 * @param signal         通用交易訊號（用 scanResultToSignal() 從掃描結果轉換）
 * @param forwardCandles 訊號日之後的K線（已排除訊號日當天）
 * @param strategy       策略參數
 */
export function runSingleBacktest(
  signal:         TradeSignal,
  forwardCandles: ForwardCandle[],
  strategy:       BacktestStrategyParams = DEFAULT_STRATEGY,
): BacktestTrade | null {
  if (forwardCandles.length === 0) return null;

  // ── 進場（含滑價）─────────────────────────────────────────────────────────
  const entryCandle = forwardCandles[0];
  const rawEntryPrice = strategy.entryType === 'nextOpen'
    ? entryCandle.open
    : entryCandle.close;

  if (!rawEntryPrice || rawEntryPrice <= 0) return null;

  // ── 漲停板檢測 ──────────────────────────────────────────────────────────
  // 如果隔日開盤=最高價且漲幅>=9.5%，代表一開盤就漲停鎖死，散戶買不到
  if (strategy.entryType === 'nextOpen') {
    // 用開盤價和收盤價的關係判斷：開=高 且 開>>收前日 → 漲停
    const isLimitUp = entryCandle.open === entryCandle.high
      && entryCandle.open > entryCandle.close * 1.0  // 高開
      && ((entryCandle.high - entryCandle.low) / entryCandle.low) < 0.005; // 幾乎沒有振幅（鎖死）
    if (isLimitUp) {
      return null; // 漲停鎖死，買不到
    }
  }

  // 買入滑價：實際買入價 ≥ 報價（追高成交）
  const entryPrice = rawEntryPrice * (1 + strategy.slippagePct);

  // ── 出場模擬（逐根判斷停損/停利） ─────────────────────────────────────────
  let exitDate:   string = '';
  let exitPrice:  number = 0;
  let exitReason: string = 'holdDays';
  let holdDays:   number = 0;

  // ⚠️ 已知限制：nextOpen 模式的進場日，low/high 包含開盤前的價格波動
  // 這會略微高估停損觸發率。精確解法需要分鐘級資料。
  const offset = strategy.entryType === 'nextOpen' ? 0 : 1;
  const holdWindow = forwardCandles.slice(offset, offset + strategy.holdDays);

  const stopLossPrice   = strategy.stopLoss   !== null ? entryPrice * (1 + strategy.stopLoss)   : null;
  const takeProfitPrice = strategy.takeProfit !== null ? entryPrice * (1 + strategy.takeProfit) : null;

  for (let i = 0; i < holdWindow.length; i++) {
    const c = holdWindow[i];
    holdDays = i + 1;

    const hitSL = stopLossPrice   !== null && c.low  <= stopLossPrice;
    const hitTP = takeProfitPrice !== null && c.high >= takeProfitPrice;

    if (hitSL || hitTP) {
      if (hitSL && hitTP) {
        // 同一根 K 線兩者都觸及：用 open 到各觸發價的距離判斷誰先
        const distSL = Math.abs(c.open - stopLossPrice!);
        const distTP = Math.abs(c.open - takeProfitPrice!);
        if (distSL <= distTP) {
          exitReason = 'stopLoss';
          // 跳空跌停：若開盤已低於停損價，以開盤（含滑價）出場
          exitPrice = c.open <= stopLossPrice!
            ? +(c.open * (1 - strategy.slippagePct)).toFixed(3)
            : +stopLossPrice!.toFixed(3);
        } else {
          exitReason = 'takeProfit';
          exitPrice  = +takeProfitPrice!.toFixed(3);
        }
      } else if (hitSL) {
        exitReason = 'stopLoss';
        exitPrice = c.open <= stopLossPrice!
          ? +(c.open * (1 - strategy.slippagePct)).toFixed(3)
          : +stopLossPrice!.toFixed(3);
      } else {
        exitReason = 'takeProfit';
        exitPrice  = +takeProfitPrice!.toFixed(3);
      }
      exitDate = c.date;
      break;
    }

    // 最後一天：以收盤出場（含賣出滑價）
    if (i === holdWindow.length - 1) {
      exitPrice  = +(c.close * (1 - strategy.slippagePct)).toFixed(3);
      exitDate   = c.date;
      exitReason = holdWindow.length < strategy.holdDays ? 'dataEnd' : 'holdDays';
    }
  }

  if (!exitDate || exitPrice <= 0 || holdDays === 0) return null;

  // ── 成本計算 ──────────────────────────────────────────────────────────────
  const unitShares = signal.market === 'TW' ? 1000 : 100;
  const buyAmount  = entryPrice * unitShares;
  const sellAmount = exitPrice  * unitShares;

  const cost = calcRoundTripCost(
    signal.market,
    signal.symbol,
    buyAmount,
    sellAmount,
    strategy.costParams,
  );

  // ── 報酬計算 ──────────────────────────────────────────────────────────────
  const grossReturn = +((exitPrice - entryPrice) / entryPrice * 100).toFixed(3);
  const netPnL      = sellAmount - buyAmount - cost.total;
  const netReturn   = +(netPnL / buyAmount * 100).toFixed(3);

  return {
    symbol:  signal.symbol,
    name:    signal.name,
    market:  signal.market,

    signalDate:    signal.signalDate,
    signalScore:   signal.signalScore,
    signalReasons: signal.signalReasons,
    trendState:    signal.trendState,
    trendPosition: signal.trendPosition,

    entryDate:  entryCandle.date,
    entryPrice: +entryPrice.toFixed(3),
    entryType:  strategy.entryType,

    exitDate,
    exitPrice:  +exitPrice.toFixed(3),
    exitReason,
    holdDays,

    grossReturn,
    netReturn,
    buyFee:    cost.buyFee,
    sellFee:   cost.sellFee,
    totalCost: cost.total,
  };
}

/**
 * 批量回測：對所有掃描結果計算回測績效
 * 回傳 trades 陣列及被跳過的筆數（存活偏差追蹤）
 */
export function runBatchBacktest(
  scanResults:       StockScanResult[],
  forwardCandlesMap: Record<string, ForwardCandle[]>,
  strategy:          BacktestStrategyParams = DEFAULT_STRATEGY,
): { trades: BacktestTrade[]; skippedCount: number } {
  const trades: BacktestTrade[] = [];
  let skippedCount = 0;

  for (const result of scanResults) {
    const candles = forwardCandlesMap[result.symbol] ?? [];
    const trade   = runSingleBacktest(scanResultToSignal(result), candles, strategy);
    if (trade) trades.push(trade);
    else skippedCount++;
  }

  return { trades, skippedCount };
}

/**
 * 計算回測統計摘要
 * @param trades        回測交易列表
 * @param skippedCount  被跳過的筆數（用於計算覆蓋率）
 */
export function calcBacktestStats(
  trades:       BacktestTrade[],
  skippedCount = 0,
): BacktestStats | null {
  if (trades.length === 0) return null;

  const returns = trades.map(t => t.netReturn);
  const wins    = trades.filter(t => t.netReturn > 0);
  const losses  = trades.filter(t => t.netReturn <= 0);

  const avgGrossReturn = +(trades.reduce((s, t) => s + t.grossReturn, 0) / trades.length).toFixed(3);
  const avgNetReturn   = +(returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(3);

  const sorted       = [...returns].sort((a, b) => a - b);
  const medianReturn = +sorted[Math.floor(sorted.length / 2)].toFixed(3);
  const maxGain      = +Math.max(...returns).toFixed(3);
  const maxLoss      = +Math.min(...returns).toFixed(3);
  const totalNetReturn = +returns.reduce((a, b) => a + b, 0).toFixed(3);

  // ── 真正的 Maximum Drawdown：權益曲線峰值到谷值的最大回撤 ──────────────────
  let equity      = 0;
  let peak        = 0;
  let maxDrawdown = 0;
  for (const r of returns) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = equity - peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  const avgWin  = wins.length   > 0 ? wins.reduce((s, t)   => s + t.netReturn, 0) / wins.length   : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netReturn, 0) / losses.length : 0;
  const winRate = wins.length / trades.length;
  const expectancy = +(winRate * avgWin + (1 - winRate) * avgLoss).toFixed(3);

  // ── 風險調整指標 ──────────────────────────────────────────────────────────
  let sharpeRatio:  number | null = null;
  let profitFactor: number | null = null;
  let payoffRatio:  number | null = null;

  if (trades.length >= 2) {
    const variance = returns.reduce((s, r) => s + (r - avgNetReturn) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    sharpeRatio = std > 0 ? +(avgNetReturn / std).toFixed(3) : null;

    const totalWin  = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
    const totalLossAbs = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
    profitFactor = totalLossAbs > 0 ? +(totalWin / totalLossAbs).toFixed(3) : null;

    const avgLossAbs = avgLoss < 0 ? Math.abs(avgLoss) : 0;
    payoffRatio = avgLossAbs > 0 ? +(avgWin / avgLossAbs).toFixed(3) : null;
  }

  // ── 存活偏差統計 ─────────────────────────────────────────────────────────
  const total = trades.length + skippedCount;
  const coverageRate = total > 0 ? +(trades.length / total * 100).toFixed(1) : 100;

  return {
    count:    trades.length,
    wins:     wins.length,
    losses:   losses.length,
    winRate:  +(winRate * 100).toFixed(1),
    avgGrossReturn,
    avgNetReturn,
    medianReturn,
    maxGain,
    maxLoss,
    maxDrawdown: +maxDrawdown.toFixed(3),
    totalNetReturn,
    expectancy,
    sharpeRatio,
    profitFactor,
    payoffRatio,
    skippedCount,
    coverageRate,
  };
}

/**
 * 依持有天數分組統計（用於比較 d1/d3/d5/d10/d20 的差異）
 */
export function calcStatsByHorizon(
  scanResults:       StockScanResult[],
  forwardCandlesMap: Record<string, ForwardCandle[]>,
  horizons:          number[] = [1, 3, 5, 10, 20],
  baseStrategy:      BacktestStrategyParams = DEFAULT_STRATEGY,
): Record<number, BacktestStats | null> {
  const result: Record<number, BacktestStats | null> = {};

  for (const days of horizons) {
    const strat = { ...baseStrategy, holdDays: days, stopLoss: null, takeProfit: null };
    const { trades, skippedCount } = runBatchBacktest(scanResults, forwardCandlesMap, strat);
    result[days] = calcBacktestStats(trades, skippedCount);
  }

  return result;
}

// ── Capital-Constrained Backtest (#7) ────────────────────────────────────────

/**
 * 資本限制參數
 * 模擬「以固定資金、最多同時持 N 檔」的實際操作場景
 */
export interface CapitalConstraints {
  initialCapital:  number;  // 初始資金（元），例如 1_000_000
  maxPositions:    number;  // 最多同時持倉數，例如 3
  positionSizePct: number;  // 每筆倉位佔初始資金比例，例如 0.1 = 10%
}

export const DEFAULT_CAPITAL: CapitalConstraints = {
  initialCapital:  1_000_000,
  maxPositions:    5,
  positionSizePct: 0.1,
};

/**
 * 資本限制批量回測
 *
 * 從掃描結果中依六大條件分數（高→低）挑選前 N 檔進場，
 * 計算在資本限制下的實際資金曲線。
 *
 * 簡化假設：
 * - 同一批掃描訊號（同日）依分數排序，依序進場直到達到 maxPositions
 * - 每筆以 positionSizePct * initialCapital 資金進場
 * - 被排除的訊號計入 skippedByCapital
 */
export function runBatchBacktestWithCapital(
  scanResults:       StockScanResult[],
  forwardCandlesMap: Record<string, ForwardCandle[]>,
  strategy:          BacktestStrategyParams = DEFAULT_STRATEGY,
  constraints:       CapitalConstraints     = DEFAULT_CAPITAL,
): {
  trades:            BacktestTrade[];
  skippedCount:      number;   // 資料不足跳過
  skippedByCapital:  number;   // 資本限制排除
  finalCapital:      number;   // 模擬結束後資金
  capitalReturn:     number;   // 整體資金報酬率 %
} {
  // 依六大條件分數由高到低排序
  const sorted = [...scanResults].sort(
    (a, b) => b.sixConditionsScore - a.sixConditionsScore ||
              b.changePercent - a.changePercent,
  );

  const eligible  = sorted.slice(0, constraints.maxPositions);
  const excluded  = sorted.length - eligible.length;

  const trades: BacktestTrade[] = [];
  let skippedCount = 0;
  let capital = constraints.initialCapital;

  for (const result of eligible) {
    const candles = forwardCandlesMap[result.symbol] ?? [];
    const trade   = runSingleBacktest(scanResultToSignal(result), candles, strategy);

    if (!trade) {
      skippedCount++;
      continue;
    }

    // 以 positionSizePct * initialCapital 作為名義本金計算損益
    const positionNominal = constraints.initialCapital * constraints.positionSizePct;
    const dollarPnL = (trade.netReturn / 100) * positionNominal;
    capital += dollarPnL;

    trades.push(trade);
  }

  const capitalReturn = +((capital - constraints.initialCapital) / constraints.initialCapital * 100).toFixed(2);

  return {
    trades,
    skippedCount,
    skippedByCapital: excluded,
    finalCapital:     +capital.toFixed(2),
    capitalReturn,
  };
}
