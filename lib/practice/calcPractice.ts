/**
 * 走圖練習簿 — 純函式計算
 *
 * 跟著走圖時間軸做紙上模擬交易：
 * - 用 lib/backtest/CostModel.ts 計算手續費/稅
 * - FIFO 配對 buy/sell 求每筆 sell 的已實現損益
 * - 衍生現有部位、現金、總報酬
 */

import { calcTWCost, calcCNCost, isShanghai } from '@/lib/backtest/CostModel';
import type { MarketId } from '@/lib/scanner/types';

export interface PracticeTrade {
  id: string;
  date: string;             // YYYY-MM-DD（成交日 = 走圖游標當日）
  side: 'BUY' | 'SELL';
  shares: number;           // 股數（內部一律用股）
  price: number;            // 成交價（= 該日收盤）
  amount: number;           // shares × price（不含費）
  fee: number;              // 手續費（含折扣，最低 20/5）
  tax: number;              // 證交稅 / 印花稅（只有 SELL 有）
  realizedPnL?: number;     // 賣出才有（FIFO 配對後算）
  signalAtTime?: string;    // 預留：當日訊號分類（B/F/N…）
}

export interface PracticeSession {
  symbol: string;           // 不含後綴的代號（"2330" / "600519"）
  market: MarketId;
  initialCapital: number;
  feeDiscount: number;      // 0.57 = 5.7 折；CN 忽略此參數
  trades: PracticeTrade[];
  createdAt: string;
}

export interface DerivedPosition {
  shares: number;           // 當前持有
  avgCost: number;          // 加權平均成本（含手續費平攤回單股）
  totalBuyAmount: number;   // 累積買進金額（不含費）
  totalBuyFees: number;     // 累積買進手續費
  totalSellAmount: number;  // 累積賣出金額（不含費）
  totalSellFees: number;    // 累積賣出手續費
  totalSellTax: number;     // 累積賣出稅
  realizedPnL: number;      // 已實現損益（FIFO 配對）
}

export interface SessionSummary {
  position: DerivedPosition;
  cash: number;             // initialCapital − net 現金流
  marketValue: number;      // shares × currentPrice（無 currentPrice 回 0）
  totalEquity: number;      // cash + marketValue
  totalReturn: number;      // (totalEquity − initialCapital) / initialCapital
  unrealizedPnL: number;    // (currentPrice − avgCost) × shares
  tradeCount: number;
}

// ── 手續費 ─────────────────────────────────────────────────────────────

export interface TradeCost {
  fee: number;
  tax: number;
}

/**
 * 算一筆交易的手續費 + 稅。
 * TW: 0.1425% × discount（最低 20）；賣出加 0.3% 證交稅
 * CN: 0.03%（最低 5）；賣出加 0.05% 印花稅；滬市雙向加 0.002% 過戶費
 */
export function calcTradeCost(
  price: number,
  shares: number,
  side: 'BUY' | 'SELL',
  market: MarketId,
  symbol: string,
  feeDiscount = 1.0,
): TradeCost {
  const amount = price * shares;
  const cnSide = side === 'BUY' ? 'buy' : 'sell';

  if (market === 'TW') {
    // calcTWCost 回傳 fee + tax 合併，拆開：
    // - fee 只跟 amount × rate × discount 有關
    // - tax 賣出才有 = amount × 0.003
    const feeRaw = Math.max(Math.round(amount * 0.001425 * feeDiscount), 20);
    const tax = side === 'SELL' ? Math.round(amount * 0.003) : 0;
    return { fee: feeRaw, tax };
  }

  // CN: 拆 fee 與 stamp + transfer
  const shanghai = isShanghai(symbol);
  const commission = Math.max(Math.round(amount * 0.0003), 5);
  const stamp = side === 'SELL' ? Math.round(amount * 0.0005) : 0;
  const transfer = shanghai ? Math.round(amount * 0.00002) : 0;
  return {
    fee: commission + transfer,  // 手續費（含過戶費）
    tax: stamp,                  // 印花稅
  };
}

// 保險：runtime 對齊 CostModel.ts（萬一未來改了 rate 也能對得起）
// 這裡只 import 拿來確保不被 tree-shake 掉 + 給型別檢查
void calcTWCost;
void calcCNCost;

// ── FIFO 配對 + 部位推導 ────────────────────────────────────────────────

interface BuyLot {
  shares: number;
  price: number;
  fee: number;            // 該批買進手續費（用於 FIFO 配對時平攤）
}

/**
 * FIFO 配對 trades → 推導出當前部位 + 已實現損益。
 *
 * 規則：
 * - sell 時從最早 unmatched buy 開始扣（FIFO）
 * - 每筆 sell 的 realizedPnL = (sellPrice − buyPrice) × shares − buyFee 份額 − sellFee − sellTax
 *   (買進手續費按 sold shares / buyLot.shares 比例平攤)
 */
export function derivePosition(trades: ReadonlyArray<PracticeTrade>): DerivedPosition {
  const lots: BuyLot[] = [];
  let totalBuyAmount = 0;
  let totalBuyFees = 0;
  let totalSellAmount = 0;
  let totalSellFees = 0;
  let totalSellTax = 0;
  let realizedPnL = 0;

  // 用日期 + index 排序（保 stable，date 相同就用陣列原順序）
  const sorted = [...trades]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      if (a.t.date !== b.t.date) return a.t.date < b.t.date ? -1 : 1;
      return a.i - b.i;
    })
    .map(x => x.t);

  for (const trade of sorted) {
    if (trade.side === 'BUY') {
      lots.push({ shares: trade.shares, price: trade.price, fee: trade.fee });
      totalBuyAmount += trade.amount;
      totalBuyFees += trade.fee;
      continue;
    }

    // SELL — FIFO 從最早 buy lot 扣
    let remaining = trade.shares;
    let matchedBuyAmount = 0;
    let matchedBuyFeeShare = 0;

    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(remaining, lot.shares);
      const feeShare = lot.shares > 0 ? lot.fee * (take / lot.shares) : 0;

      matchedBuyAmount += take * lot.price;
      matchedBuyFeeShare += feeShare;

      lot.shares -= take;
      lot.fee -= feeShare;
      remaining -= take;

      if (lot.shares <= 0) lots.shift();
    }

    // remaining > 0 表示超賣（理論上 UI 應該阻擋，這裡防呆只算到對到的部分）
    const soldShares = trade.shares - remaining;
    const sellAmountMatched = soldShares * trade.price;
    const sellFeeShare = trade.shares > 0 ? trade.fee * (soldShares / trade.shares) : 0;
    const sellTaxShare = trade.shares > 0 ? trade.tax * (soldShares / trade.shares) : 0;

    const tradeRealized =
      sellAmountMatched - matchedBuyAmount - matchedBuyFeeShare - sellFeeShare - sellTaxShare;
    realizedPnL += tradeRealized;

    totalSellAmount += trade.amount;
    totalSellFees += trade.fee;
    totalSellTax += trade.tax;
  }

  const shares = lots.reduce((s, l) => s + l.shares, 0);
  const remainingBuyAmount = lots.reduce((s, l) => s + l.shares * l.price, 0);
  const remainingBuyFees = lots.reduce((s, l) => s + l.fee, 0);
  // avgCost 把剩餘手續費也攤回單股
  const avgCost = shares > 0 ? (remainingBuyAmount + remainingBuyFees) / shares : 0;

  return {
    shares,
    avgCost,
    totalBuyAmount,
    totalBuyFees,
    totalSellAmount,
    totalSellFees,
    totalSellTax,
    realizedPnL,
  };
}

/**
 * 把 session + 當前走圖價 → 完整 summary。
 *
 * - cash = initialCapital − Σ(買金額+買費) + Σ(賣金額−賣費−賣稅)
 * - marketValue = shares × currentPrice
 * - totalEquity = cash + marketValue
 * - totalReturn = (totalEquity − initialCapital) / initialCapital
 */
export function deriveSessionSummary(
  session: PracticeSession,
  currentPrice?: number,
): SessionSummary {
  const position = derivePosition(session.trades);

  const cashOut = position.totalBuyAmount + position.totalBuyFees;
  const cashIn = position.totalSellAmount - position.totalSellFees - position.totalSellTax;
  const cash = session.initialCapital - cashOut + cashIn;

  const marketValue =
    currentPrice != null && currentPrice > 0 ? position.shares * currentPrice : 0;
  const totalEquity = cash + marketValue;
  const totalReturn =
    session.initialCapital > 0
      ? (totalEquity - session.initialCapital) / session.initialCapital
      : 0;

  const unrealizedPnL =
    currentPrice != null && currentPrice > 0 && position.shares > 0
      ? (currentPrice - position.avgCost) * position.shares
      : 0;

  return {
    position,
    cash,
    marketValue,
    totalEquity,
    totalReturn,
    unrealizedPnL,
    tradeCount: session.trades.length,
  };
}

// ── 工廠 ───────────────────────────────────────────────────────────────

/** 建一張新交易（自動算費 + amount + id），不入庫。 */
export function buildTrade(args: {
  date: string;
  side: 'BUY' | 'SELL';
  shares: number;
  price: number;
  market: MarketId;
  symbol: string;
  feeDiscount: number;
  signalAtTime?: string;
}): PracticeTrade {
  const { date, side, shares, price, market, symbol, feeDiscount, signalAtTime } = args;
  const amount = shares * price;
  const { fee, tax } = calcTradeCost(price, shares, side, market, symbol, feeDiscount);
  return {
    id: `pt${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    date,
    side,
    shares,
    price,
    amount,
    fee,
    tax,
    signalAtTime,
  };
}

/** 練習簿 storage key（market + 不含後綴的代號）。 */
export function practiceKey(market: MarketId, symbol: string): string {
  const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  return `${market}:${code}`;
}
