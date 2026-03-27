/**
 * 當沖模擬交易引擎
 * 台股當沖稅率 0.15%（優惠）
 */

import type { PaperTrade, PaperPosition, DayTradeSession } from './types';

const TW_FEE_RATE = 0.001425;  // 手續費 0.1425%
const TW_FEE_DISCOUNT = 0.6;   // 六折
const TW_DAY_TRADE_TAX = 0.0015; // 當沖稅 0.15%

let tradeCounter = 0;

export class PaperTradingEngine {
  private session: DayTradeSession;

  constructor(symbol: string, initialCapital: number, date: string) {
    this.session = {
      id: `dt-${date}-${Date.now()}`,
      symbol,
      date,
      startTime: new Date().toISOString(),
      initialCapital,
      currentCapital: initialCapital,
      trades: [],
      signals: [],
      position: null,
      realizedPnL: 0,
      unrealizedPnL: 0,
      totalPnL: 0,
      returnPct: 0,
      maxDrawdown: 0,
      peakCapital: initialCapital,
      winCount: 0,
      lossCount: 0,
    };
  }

  private calcBuyFee(amount: number): number {
    return Math.max(20, Math.round(amount * TW_FEE_RATE * TW_FEE_DISCOUNT));
  }

  private calcSellFee(amount: number): number {
    const commission = Math.max(20, Math.round(amount * TW_FEE_RATE * TW_FEE_DISCOUNT));
    const tax = Math.round(amount * TW_DAY_TRADE_TAX);
    return commission + tax;
  }

  buy(price: number, shares: number, timestamp: string, signalId?: string): PaperTrade | null {
    const amount = price * shares;
    const fee = this.calcBuyFee(amount);
    const totalCost = amount + fee;

    if (totalCost > this.session.currentCapital) return null;

    const trade: PaperTrade = {
      id: `t-${++tradeCounter}`,
      symbol: this.session.symbol,
      action: 'BUY',
      price,
      shares,
      amount,
      fee,
      timestamp,
      signalId,
    };

    this.session.trades.push(trade);
    this.session.currentCapital -= totalCost;

    // 更新持倉
    if (this.session.position) {
      const pos = this.session.position;
      const totalShares = pos.shares + shares;
      pos.avgCost = (pos.avgCost * pos.shares + price * shares) / totalShares;
      pos.shares = totalShares;
    } else {
      this.session.position = {
        symbol: this.session.symbol,
        shares,
        avgCost: price,
        currentPrice: price,
        unrealizedPnL: 0,
        unrealizedPnLPct: 0,
      };
    }

    return trade;
  }

  sell(price: number, shares: number, timestamp: string, signalId?: string): PaperTrade | null {
    if (!this.session.position || this.session.position.shares < shares) return null;

    const amount = price * shares;
    const fee = this.calcSellFee(amount);
    const netAmount = amount - fee;

    // 計算已實現損益（買入手續費已計入 avgCost，不再重複扣除）
    const costBasis = this.session.position.avgCost * shares;
    const pnl = netAmount - costBasis;

    const trade: PaperTrade = {
      id: `t-${++tradeCounter}`,
      symbol: this.session.symbol,
      action: 'SELL',
      price,
      shares,
      amount,
      fee,
      timestamp,
      signalId,
      realizedPnL: Math.round(pnl),
    };

    this.session.trades.push(trade);
    this.session.currentCapital += netAmount;
    this.session.realizedPnL += pnl;

    if (pnl > 0) this.session.winCount++;
    else if (pnl < 0) this.session.lossCount++;

    // 更新持倉
    this.session.position.shares -= shares;
    if (this.session.position.shares <= 0) {
      this.session.position = null;
    }

    this.updateSessionMetrics(price);
    return trade;
  }

  closeAllPositions(price: number, timestamp: string): PaperTrade[] {
    if (!this.session.position || this.session.position.shares <= 0) return [];
    const trade = this.sell(price, this.session.position.shares, timestamp);
    return trade ? [trade] : [];
  }

  updatePrice(currentPrice: number): void {
    if (this.session.position) {
      this.session.position.currentPrice = currentPrice;
      const pnl = (currentPrice - this.session.position.avgCost) * this.session.position.shares;
      this.session.position.unrealizedPnL = Math.round(pnl);
      this.session.position.unrealizedPnLPct =
        ((currentPrice - this.session.position.avgCost) / this.session.position.avgCost) * 100;
    }
    this.updateSessionMetrics(currentPrice);
  }

  private updateSessionMetrics(currentPrice: number): void {
    const s = this.session;
    const posValue = s.position ? s.position.shares * currentPrice : 0;
    const totalAsset = s.currentCapital + posValue;

    s.unrealizedPnL = s.position?.unrealizedPnL ?? 0;
    s.totalPnL = s.realizedPnL + s.unrealizedPnL;
    s.returnPct = ((totalAsset - s.initialCapital) / s.initialCapital) * 100;

    if (totalAsset > s.peakCapital) s.peakCapital = totalAsset;
    const dd = ((s.peakCapital - totalAsset) / s.peakCapital) * 100;
    if (dd > s.maxDrawdown) s.maxDrawdown = dd;
  }

  getSession(): DayTradeSession { return { ...this.session }; }

  getPosition(): PaperPosition | null {
    return this.session.position ? { ...this.session.position } : null;
  }
}
