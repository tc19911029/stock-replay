import { AccountState, AccountMetrics, Trade } from '@/types';

const TRADE_FEE_RATE = 0.001425; // 0.1425% 買賣手續費
const SELL_TAX_RATE  = 0.003;    // 0.3%  賣出證交稅 (台股)
const TW_MIN_FEE     = 20;       // 台股券商最低手續費 20 元（與 lib/backtest/CostModel.ts 一致）

/**
 * Calculate transaction fee (買賣手續費)
 * 對齊 CostModel：手續費取 max(rate × amount, 20 元最低)
 */
export function calcFee(amount: number, action: 'BUY' | 'SELL'): number {
  const fee = Math.max(TW_MIN_FEE, Math.round(amount * TRADE_FEE_RATE));
  const tax = action === 'SELL' ? Math.round(amount * SELL_TAX_RATE) : 0;
  return fee + tax;
}

/**
 * Create initial empty account state
 */
export function createAccount(initialCapital: number): AccountState {
  return {
    initialCapital,
    cash: initialCapital,
    shares: 0,
    avgCost: 0,
    realizedPnL: 0,
    trades: [],
  };
}

/**
 * Execute a BUY order.
 * Taiwan stocks are traded in lots of 1000 shares (張).
 * This engine supports any share count for flexibility.
 *
 * @param state - Current account state (immutable)
 * @param price - Execution price (close of current candle)
 * @param shares - Number of shares to buy
 * @param date - Trade date
 * @returns New account state after the trade, or null if insufficient funds
 */
export function executeBuy(
  state: AccountState,
  price: number,
  shares: number,
  date: string
): AccountState | null {
  if (shares <= 0) return null;
  const amount = price * shares;
  const fee = calcFee(amount, 'BUY');
  const totalCost = amount + fee;

  if (totalCost > state.cash) return null; // insufficient funds

  const trade: Trade = {
    id: `trade-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    date,
    action: 'BUY',
    price,
    shares,
    amount,
    fee,
  };

  // Update average cost (加權平均成本) — 包含買進手續費，這樣 sell 時的 realizedPnL 會正確扣到雙邊費
  const totalCurrentValue = state.shares * state.avgCost;
  const newShares = state.shares + shares;
  const newAvgCost = newShares > 0
    ? (totalCurrentValue + amount + fee) / newShares
    : 0;

  return {
    ...state,
    cash: state.cash - totalCost,
    shares: newShares,
    avgCost: +newAvgCost.toFixed(4),
    trades: [...state.trades, trade],
  };
}

/**
 * Execute a SELL order.
 *
 * @returns New account state, or null if insufficient shares
 */
export function executeSell(
  state: AccountState,
  price: number,
  shares: number,
  date: string
): AccountState | null {
  if (shares <= 0 || shares > state.shares) return null;

  const amount = price * shares;
  const fee = calcFee(amount, 'SELL');
  const proceeds = amount - fee;

  // Realized P&L = (sell price - avg cost) * shares - fees
  const costBasis = state.avgCost * shares;
  const realizedPnL = proceeds - costBasis;

  const trade: Trade = {
    id: `trade-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    date,
    action: 'SELL',
    price,
    shares,
    amount,
    fee,
    realizedPnL: +realizedPnL.toFixed(2),
  };

  const newShares = state.shares - shares;

  return {
    ...state,
    cash: state.cash + proceeds,
    shares: newShares,
    avgCost: newShares === 0 ? 0 : state.avgCost, // keep avgCost until fully closed
    realizedPnL: state.realizedPnL + realizedPnL,
    trades: [...state.trades, trade],
  };
}

/**
 * Compute live metrics based on current price.
 * Call this on every candle advance.
 */
export function computeMetrics(
  state: AccountState,
  currentPrice: number
): AccountMetrics {
  const holdingValue = state.shares * currentPrice;
  const unrealizedPnL = state.shares > 0
    ? holdingValue - state.shares * state.avgCost
    : 0;
  const totalAssets = state.cash + holdingValue;
  const returnRate = (totalAssets - state.initialCapital) / state.initialCapital;

  return {
    cash: state.cash,
    shares: state.shares,
    avgCost: state.avgCost,
    holdingValue,
    unrealizedPnL,
    realizedPnL: state.realizedPnL,
    totalAssets,
    returnRate,
  };
}

/**
 * 最多能買幾股（考慮手續費 max(20, rate × amount)）
 *
 * 兩種情況：
 *   小額：fee = 20 → 解 cash >= price × n + 20
 *   大額：fee = rate × amount → 解 cash >= price × n × (1 + rate)
 */
function maxSharesForBudget(budget: number, price: number): number {
  if (budget <= 0 || price <= 0) return 0;
  // 假設用 floor rate 的解；若手續費走最低 20 會更嚴格，再縮一股直到 totalCost ≤ budget
  let n = Math.floor(budget / (price * (1 + TRADE_FEE_RATE)));
  while (n > 0) {
    const amount = price * n;
    const fee = Math.max(TW_MIN_FEE, Math.round(amount * TRADE_FEE_RATE));
    if (amount + fee <= budget) return n;
    n--;
  }
  return 0;
}

/**
 * Calculate max buy shares given available cash and price.
 * Rounds down to whole shares.
 */
export function maxBuyShares(cash: number, price: number): number {
  return maxSharesForBudget(cash, price);
}

/**
 * Calculate shares from a capital percentage.
 * e.g. 0.5 = use 50% of available cash
 */
export function sharesFromPercent(
  cash: number,
  price: number,
  percent: number
): number {
  return maxSharesForBudget(cash * percent, price);
}
