/**
 * Signal conversion utilities — converts scanner results to
 * BacktestEngine-compatible TradeSignal format.
 *
 * Extracted from BacktestEngine.ts for modularity.
 */

import { StockScanResult } from '@/lib/scanner/types';
import type { TradeSignal, BacktestStrategyParams } from './BacktestEngine';

/**
 * Convert a scan result to a universal trade signal.
 * This is the bridge between scanner output and the backtest engine.
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
    industry:      scanResult.industry,
    signalDate:    scanResult.scanTime.split('T')[0],
    signalScore:   sixConditionsScore,
    signalReasons: reasons,
    trendState,
    trendPosition,
    histWinRate:   scanResult.histWinRate,
    highWinRateTypes: scanResult.highWinRateTypes,
    highWinRateScore: scanResult.highWinRateScore,
    winnerBullishPatterns: scanResult.winnerBullishPatterns,
    winnerBearishPatterns: scanResult.winnerBearishPatterns,
    eliminationPenalty: scanResult.eliminationPenalty,
    direction: scanResult.direction,
    signalPrice: scanResult.price,
  };
}

/**
 * Adaptive exit parameters based on signal quality.
 * Returns base strategy as-is (removed fields cleaned up).
 */
export function resolveAdaptiveParams(
  _signal: TradeSignal,
  baseStrategy: BacktestStrategyParams,
): BacktestStrategyParams {
  return { ...baseStrategy };
}
