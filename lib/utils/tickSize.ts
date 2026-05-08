/**
 * 股價檔位（tick size）規則
 *
 * 對應 v12 議題 40 / S3-11：價格比較需用 tick-size 處理浮點精度。
 *
 * 書本：抓飆股 p.338 真突破 ×3% 與 K 線最低點停損都涉及邊界價格，
 * 為避免浮點誤差（例如 102.99 vs 103.00），用 tick-size 量化比較。
 */

import type { MarketId } from '../scanner/types';

/**
 * 回傳指定市場 + 股價對應的 tick size（最小升降單位）
 *
 * @param price 當前股價
 * @param market 市場代碼
 * @returns tick size（元）
 *
 * @example
 *   getTickSize(45, 'TW')   // 0.05
 *   getTickSize(150, 'TW')  // 0.5
 *   getTickSize(15, 'CN')   // 0.01
 */
export function getTickSize(price: number, market: MarketId): number {
  if (market === 'TW') {
    // 台股檔位規則（依股價區間）
    if (price < 10) return 0.01;
    if (price < 50) return 0.05;
    if (price < 100) return 0.1;
    if (price < 500) return 0.5;
    if (price < 1000) return 1;
    return 5;
  }

  if (market === 'CN') {
    // 中國 A 股一律 0.01 元
    return 0.01;
  }

  // 預設保守值
  return 0.01;
}

/**
 * 將價格四捨五入到 tick size 邊界
 *
 * @param price 原始價格
 * @param market 市場
 * @param mode 'round' | 'floor' | 'ceil'
 */
export function roundToTick(
  price: number,
  market: MarketId,
  mode: 'round' | 'floor' | 'ceil' = 'round',
): number {
  const tick = getTickSize(price, market);
  const ratio = price / tick;
  const rounded = mode === 'floor'
    ? Math.floor(ratio)
    : mode === 'ceil'
      ? Math.ceil(ratio)
      : Math.round(ratio);
  return Number((rounded * tick).toFixed(4));
}

/**
 * 判定 a 是否「實質上小於或等於」b（考慮 tick 容忍度）
 *
 * 用於停損判定：避免 102.99 vs 103.00 因浮點誤差誤判。
 */
export function ltOrEqWithTick(a: number, b: number, market: MarketId): boolean {
  const tick = getTickSize(b, market);
  return a <= b + tick * 0.5;
}

/**
 * 判定 a 是否「實質上大於或等於」b（考慮 tick 容忍度）
 */
export function gtOrEqWithTick(a: number, b: number, market: MarketId): boolean {
  const tick = getTickSize(b, market);
  return a >= b - tick * 0.5;
}
