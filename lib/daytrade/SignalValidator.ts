/**
 * 當沖訊號驗證器
 * 驗證每個訊號的後續表現
 */

import type {
  IntradaySignal,
  IntradayCandleWithIndicators,
  SignalValidation,
  ValidationStatistics,
  IntradayTimeframe,
} from './types';

// 交易成本常數（台股當沖）
const COMMISSION_RATE = 0.001425;  // 券商手續費 0.1425%（通常打6折 = 0.0855%）
const COMMISSION_DISCOUNT = 0.6;   // 手續費折扣
const TAX_RATE_SELL = 0.0015;      // 當沖證交稅 0.15%（正常0.3%減半）
const SLIPPAGE_BPS = 2;            // 滑價 2 個基點（大型股流動性好）

export function validateSignal(
  signal: IntradaySignal,
  candles: IntradayCandleWithIndicators[],
  signalIndex: number,
  forwardBars: number[] = [3, 5, 10],
): SignalValidation {
  const rawEntry = candles[signalIndex].close;
  // 模擬實際成交價：加入滑價
  const slippage = rawEntry * SLIPPAGE_BPS / 10000;
  const entryPrice = signal.type === 'BUY' || signal.type === 'ADD'
    ? rawEntry + slippage   // 買入價略高
    : rawEntry - slippage;  // 賣出價略低
  const isBuy = signal.type === 'BUY' || signal.type === 'ADD';

  const returns: { bars3: number | null; bars5: number | null; bars10: number | null } = {
    bars3: null, bars5: null, bars10: null,
  };

  let maxFav = 0, maxAdv = 0;

  // 計算各期間回報（含交易成本）
  // 當沖成本：買手續費(打折) + 賣手續費(打折) + 證交稅(當沖減半) ≈ 0.321%
  const roundTripCost = (COMMISSION_RATE * COMMISSION_DISCOUNT * 2 + TAX_RATE_SELL) * 100;
  for (const bars of forwardBars) {
    const targetIdx = signalIndex + bars;
    if (targetIdx >= candles.length) continue;
    const exitPrice = candles[targetIdx].close;
    const grossRet = ((exitPrice - entryPrice) / entryPrice) * 100;
    const ret = grossRet - roundTripCost;  // 扣除來回交易成本
    if (bars === 3) returns.bars3 = Math.round(ret * 100) / 100;
    if (bars === 5) returns.bars5 = Math.round(ret * 100) / 100;
    if (bars === 10) returns.bars10 = Math.round(ret * 100) / 100;
  }

  // 最大順行 / 逆行
  const maxLookforward = Math.min(signalIndex + 10, candles.length);
  for (let i = signalIndex + 1; i < maxLookforward; i++) {
    const ret = ((candles[i].close - entryPrice) / entryPrice) * 100;
    if (isBuy) {
      if (ret > maxFav) maxFav = ret;
      if (ret < -maxAdv) maxAdv = -ret;
    } else {
      if (-ret > maxFav) maxFav = -ret;
      if (ret > maxAdv) maxAdv = ret;
    }
  }

  // 判斷準確性
  const primaryReturn = returns.bars5 ?? returns.bars3;
  const wasAccurate = primaryReturn != null
    ? (isBuy ? primaryReturn > 0 : primaryReturn < 0)
    : false;

  const hitTarget = signal.metadata.targetPrice != null
    ? (isBuy
      ? candles.slice(signalIndex, maxLookforward).some(c => c.high >= signal.metadata.targetPrice!)
      : candles.slice(signalIndex, maxLookforward).some(c => c.low <= signal.metadata.targetPrice!))
    : false;

  const hitStopLoss = signal.metadata.stopLossPrice != null
    ? (isBuy
      ? candles.slice(signalIndex, maxLookforward).some(c => c.low <= signal.metadata.stopLossPrice!)
      : candles.slice(signalIndex, maxLookforward).some(c => c.high >= signal.metadata.stopLossPrice!))
    : false;

  return {
    signal,
    forwardReturns: returns,
    maxFavorableExcursion: Math.round(maxFav * 100) / 100,
    maxAdverseExcursion: Math.round(maxAdv * 100) / 100,
    wasAccurate,
    hitTarget,
    hitStopLoss,
  };
}

export function aggregateValidations(validations: SignalValidation[]): ValidationStatistics {
  if (validations.length === 0) {
    return {
      totalSignals: 0, buySignals: 0, sellSignals: 0,
      accuracyRate: 0, avgReturn3Bar: 0, avgReturn5Bar: 0, avgReturn10Bar: 0,
      avgMFE: 0, avgMAE: 0, stopLossRate: 0, targetHitRate: 0,
      byType: {}, byTimeframe: {} as ValidationStatistics['byTimeframe'],
    };
  }

  const buys = validations.filter(v => ['BUY', 'ADD'].includes(v.signal.type));
  const sells = validations.filter(v => ['SELL', 'REDUCE'].includes(v.signal.type));
  const accurate = validations.filter(v => v.wasAccurate);

  const avg = (arr: (number | null)[]): number => {
    const valid = arr.filter(v => v != null) as number[];
    return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  };

  // 按類型統計
  const byType: ValidationStatistics['byType'] = {};
  for (const v of validations) {
    const t = v.signal.type;
    if (!byType[t]) byType[t] = { count: 0, accuracyRate: 0, avgReturn: 0 };
    byType[t].count++;
  }
  for (const t of Object.keys(byType)) {
    const subset = validations.filter(v => v.signal.type === t);
    const acc = subset.filter(v => v.wasAccurate);
    byType[t].accuracyRate = Math.round((acc.length / subset.length) * 100);
    byType[t].avgReturn = Math.round(avg(subset.map(v => v.forwardReturns.bars5)) * 100) / 100;
  }

  // 按週期統計
  const byTimeframe = {} as ValidationStatistics['byTimeframe'];
  for (const tf of ['1m', '5m', '15m', '60m'] as IntradayTimeframe[]) {
    const subset = validations.filter(v => v.signal.timeframe === tf);
    if (subset.length === 0) continue;
    const acc = subset.filter(v => v.wasAccurate);
    byTimeframe[tf] = {
      count: subset.length,
      accuracyRate: Math.round((acc.length / subset.length) * 100),
      avgReturn: Math.round(avg(subset.map(v => v.forwardReturns.bars5)) * 100) / 100,
    };
  }

  // Profit Factor = 總獲利 / 總虧損
  const r5s = validations.map(v => v.forwardReturns.bars5).filter(v => v != null) as number[];
  const totalProfit = r5s.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const totalLoss = Math.abs(r5s.filter(r => r < 0).reduce((s, r) => s + r, 0));
  const profitFactor = totalLoss > 0 ? Math.round((totalProfit / totalLoss) * 100) / 100 : totalProfit > 0 ? 99 : 0;

  // 中位數回報
  const sorted5 = [...r5s].sort((a, b) => a - b);
  const medianReturn = sorted5.length > 0 ? sorted5[Math.floor(sorted5.length / 2)] : 0;

  return {
    totalSignals: validations.length,
    buySignals: buys.length,
    sellSignals: sells.length,
    accuracyRate: Math.round((accurate.length / validations.length) * 100),
    avgReturn3Bar: Math.round(avg(validations.map(v => v.forwardReturns.bars3)) * 100) / 100,
    avgReturn5Bar: Math.round(avg(validations.map(v => v.forwardReturns.bars5)) * 100) / 100,
    avgReturn10Bar: Math.round(avg(validations.map(v => v.forwardReturns.bars10)) * 100) / 100,
    avgMFE: Math.round(avg(validations.map(v => v.maxFavorableExcursion)) * 100) / 100,
    avgMAE: Math.round(avg(validations.map(v => v.maxAdverseExcursion)) * 100) / 100,
    stopLossRate: Math.round((validations.filter(v => v.hitStopLoss).length / validations.length) * 100),
    targetHitRate: Math.round((validations.filter(v => v.hitTarget).length / validations.length) * 100),
    profitFactor,
    medianReturn: Math.round(medianReturn * 100) / 100,
    byType,
    byTimeframe,
  };
}
