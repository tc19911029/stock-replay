/**
 * CostModel.ts — 交易成本模型
 *
 * 台股：手續費 0.1425%（買賣均收）+ 證交稅 0.3%（賣出）
 * 陸股：佣金 0.03%（買賣均收，最低 5 元）+ 印花稅 0.05%（賣出，2023.8 起；舊 0.1% 已過期）+ 過戶費 0.002%（滬股雙向）
 */

import { MarketId } from '@/lib/scanner/types';

export interface CostParams {
  /** 台股：手續費折扣（0.6 = 六折，預設 1.0 不折扣） */
  twFeeDiscount?: number;
  /** 陸股：是否為滬市（計算過戶費，深市不收） */
  cnIsShanghai?: boolean;
}

export interface TransactionCost {
  buyFee:   number;   // 買入手續費（含稅）
  sellFee:  number;   // 賣出手續費（含稅）
  total:    number;   // buyFee + sellFee
  /** 以本金百分比表示的雙邊成本 */
  roundTripPct: number;
}

// ── Taiwan ─────────────────────────────────────────────────────────────────────

const TW_FEE_RATE = 0.001425; // 0.1425%
const TW_TAX_RATE = 0.003;    // 0.3% 證交稅（賣出）
const TW_MIN_FEE  = 20;       // 最低手續費（元）

/**
 * 計算台股單邊成本
 * @param amount 成交金額（元）
 * @param side   'buy' | 'sell'
 * @param discount 手續費折扣，預設 1.0（無折扣）
 */
export function calcTWCost(
  amount: number,
  side: 'buy' | 'sell',
  discount = 1.0,
): number {
  const fee = Math.max(Math.round(amount * TW_FEE_RATE * discount), TW_MIN_FEE);
  const tax = side === 'sell' ? Math.round(amount * TW_TAX_RATE) : 0;
  return fee + tax;
}

// ── China A-share ───────────────────────────────────────────────────────────────

const CN_COMMISSION_RATE = 0.0003; // 0.03% 佣金
const CN_MIN_COMMISSION  = 5;      // 最低佣金（元）
const CN_STAMP_RATE      = 0.0005; // 0.05% 印花稅（賣出，2023.8.28 從 0.1% 減半起新制）
const CN_TRANSFER_RATE   = 0.00002; // 0.002% 過戶費（滬市雙向）

/**
 * 計算陸股單邊成本
 * @param amount    成交金額（元）
 * @param side      'buy' | 'sell'
 * @param isShanghai 是否為滬市（603xxx / 600xxx / 601xxx 開頭）
 */
export function calcCNCost(
  amount: number,
  side: 'buy' | 'sell',
  isShanghai = false,
): number {
  const commission = Math.max(Math.round(amount * CN_COMMISSION_RATE), CN_MIN_COMMISSION);
  const stamp      = side === 'sell' ? Math.round(amount * CN_STAMP_RATE) : 0;
  const transfer   = isShanghai ? Math.round(amount * CN_TRANSFER_RATE) : 0;
  return commission + stamp + transfer;
}

/** 判斷陸股代號是否為滬市 */
export function isShanghai(symbol: string): boolean {
  const code = symbol.replace(/\.(SS|SZ)$/i, '');
  return /^(6|9)/.test(code); // 600xxx, 601xxx, 603xxx, 688xxx, 900xxx
}

// ── Unified ────────────────────────────────────────────────────────────────────

/**
 * 計算一筆完整交易（買 + 賣）的總成本
 *
 * @param market     'TW' | 'CN'
 * @param buyAmount  買入金額
 * @param sellAmount 賣出金額（等於 buyAmount × exitPrice / entryPrice）
 * @param params     可選參數
 */
export function calcRoundTripCost(
  market:     MarketId,
  symbol:     string,
  buyAmount:  number,
  sellAmount: number,
  params:     CostParams = {},
): TransactionCost {
  let buyFee: number;
  let sellFee: number;

  if (market === 'TW') {
    const discount = params.twFeeDiscount ?? 1.0;
    buyFee  = calcTWCost(buyAmount,  'buy',  discount);
    sellFee = calcTWCost(sellAmount, 'sell', discount);
  } else {
    const shanghai = isShanghai(symbol);
    buyFee  = calcCNCost(buyAmount,  'buy',  shanghai);
    sellFee = calcCNCost(sellAmount, 'sell', shanghai);
  }

  const total = buyFee + sellFee;
  const roundTripPct = (total / buyAmount) * 100;

  return { buyFee, sellFee, total, roundTripPct: +roundTripPct.toFixed(4) };
}
