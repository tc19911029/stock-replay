import { Trade, PerformanceStats, AccountState, CandleWithIndicators } from '@/types';

/**
 * Compute performance statistics from trade history.
 * Call this whenever trades or current price changes.
 */
export function computeStats(
  state: AccountState,
  candles: CandleWithIndicators[],
  currentIndex: number
): PerformanceStats {
  const sellTrades = state.trades.filter((t) => t.action === 'SELL');
  const winTrades  = sellTrades.filter((t) => (t.realizedPnL ?? 0) > 0);
  const lossTrades = sellTrades.filter((t) => (t.realizedPnL ?? 0) <= 0);

  const totalRealizedPnL = sellTrades.reduce(
    (sum, t) => sum + (t.realizedPnL ?? 0),
    0
  );

  // Build equity curve: replay account value at each candle date
  // This is a simplified version — we track assets at each candle where a trade occurred
  const equityCurve = buildEquityCurve(state, candles, currentIndex);

  const totalAssets =
    state.cash +
    state.shares * (candles[currentIndex]?.close ?? 0);

  return {
    totalTrades: sellTrades.length,
    winCount: winTrades.length,
    lossCount: lossTrades.length,
    winRate: sellTrades.length > 0 ? winTrades.length / sellTrades.length : 0,
    totalRealizedPnL,
    totalReturnRate: (totalAssets - state.initialCapital) / state.initialCapital,
    equityCurve,
  };
}

/**
 * 連續權益曲線：每根 K 棒都記錄一個資產淨值點
 *
 * 舊版本只在交易發生時才記錄資產，導致圖形呈階梯狀、
 * 無法反映持倉期間的浮動盈虧。
 * 此版本在 candles[0..currentIndex] 的每根 K 棒都計算
 * cash + shares * close，產生連續的 equity curve。
 */
function buildEquityCurve(
  state: AccountState,
  candles: CandleWithIndicators[],
  currentIndex: number
): { date: string; totalAssets: number }[] {
  if (candles.length === 0) return [];

  const curve: { date: string; totalAssets: number }[] = [];

  // 按日期排序交易列表，方便逐 K 棒累計
  const sortedTrades = [...state.trades].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  let cash   = state.initialCapital;
  let shares = 0;
  let tradeIdx = 0;

  for (let i = 0; i <= Math.min(currentIndex, candles.length - 1); i++) {
    const candle = candles[i];

    // 先套用所有在此 K 棒日期成交的交易（開盤前已成交的概念）
    while (
      tradeIdx < sortedTrades.length &&
      sortedTrades[tradeIdx].date <= candle.date
    ) {
      const t = sortedTrades[tradeIdx];
      if (t.action === 'BUY') {
        cash   -= t.amount + t.fee;
        shares += t.shares;
      } else {
        cash   += t.amount - t.fee;
        shares -= t.shares;
        if (shares < 0) shares = 0; // 防止浮點誤差
      }
      tradeIdx++;
    }

    // 以收盤價計算當日資產淨值
    const totalAssets = cash + shares * candle.close;
    curve.push({ date: candle.date, totalAssets: +totalAssets.toFixed(2) });
  }

  return curve;
}

/**
 * Format a number as currency with commas (e.g. 1,234,567)
 */
export function formatCurrency(n: number): string {
  return Math.round(n).toLocaleString('zh-TW');
}

/**
 * Format a return rate as percentage with sign (e.g. +12.34%)
 */
export function formatReturn(rate: number): string {
  const sign = rate >= 0 ? '+' : '';
  return `${sign}${(rate * 100).toFixed(2)}%`;
}
