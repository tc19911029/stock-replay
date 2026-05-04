/**
 * Limit-up close-overwrite guard
 *
 * 漲跌停股的最終收盤在收盤集合競價，realtime/L2 snapshot 可能拍到盤中
 * 最後一筆 tick（已從漲停回落或從跌停反彈），寫入會污染 L1 close。
 *
 * 偵測模式：今日 high 觸及前日收盤 ±漲跌停幅度，但 close 偏離 high/low > 3%。
 *
 * 漲跌停幅度：
 *   - TW 上市/上櫃：±10%（含主板與興櫃）
 *   - CN 創業板（300/301）/ 科創板（688）：±20%
 *   - CN 主板（00x/60x）：±10%
 *
 * 用法：
 *   if (suspectsLimitOverwrite(prevClose, q, market, code)) skip;
 */

export interface QuoteOHLC {
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Market = 'TW' | 'CN';

export function limitPctFor(market: Market, code: string): number {
  // CN 創業板（300xxx, 301xxx）/ 科創板（688xxx） = ±20%
  if (market === 'CN' && (/^30[01]/.test(code) || /^688/.test(code))) return 0.198;
  return 0.098;
}

/**
 * 回傳 true 表示「snapshot 的 close 看起來不是真正的集合競價收盤」，呼叫端應 skip。
 *
 * 條件全部成立才回傳 true：
 *   1) prevClose 有效（>0）
 *   2) high 觸及漲停 OR low 觸及跌停
 *   3) close 與漲跌停 high/low 偏離 > 3%
 */
export function suspectsLimitOverwrite(
  prevClose: number | null | undefined,
  q: QuoteOHLC,
  market: Market,
  code: string,
): boolean {
  if (!prevClose || prevClose <= 0) return false;
  const limitPct = limitPctFor(market, code);
  const hitLimitUp = q.high >= prevClose * (1 + limitPct) * 0.999;
  const hitLimitDown = q.low <= prevClose * (1 - limitPct) * 1.001;
  return (hitLimitUp && q.close < q.high * 0.97)
      || (hitLimitDown && q.close > q.low * 1.03);
}
