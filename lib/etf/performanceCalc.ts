/**
 * ETF 多期間報酬率計算
 *
 * 報酬期間：1日、1週(5個交易日)、1月(20個交易日)、YTD、成立以來
 * 輸入：依交易日由舊到新排序的 K 棒陣列
 */
import type { Candle } from '@/types';
import type { ETFListItem, ETFPerformanceEntry } from './types';

function pctReturn(from: number, to: number): number | null {
  if (from <= 0) return null;
  return ((to - from) / from) * 100;
}

/** 找出第一根日期 ≥ targetDate 的 K 棒 index；找不到回 -1 */
function findIndexOnOrAfter(candles: Candle[], targetDate: string): number {
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].date >= targetDate) return i;
  }
  return -1;
}

export function computeETFPerformance(
  etf: ETFListItem,
  candles: Candle[],
): ETFPerformanceEntry | null {
  if (candles.length === 0) return null;

  const sorted = [...candles].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1];

  const d1 = sorted.length >= 2 ? pctReturn(sorted[sorted.length - 2].close, last.close) : null;
  const w1 = sorted.length >= 6 ? pctReturn(sorted[sorted.length - 6].close, last.close) : null;
  const m1 = sorted.length >= 21 ? pctReturn(sorted[sorted.length - 21].close, last.close) : null;

  const year = last.date.slice(0, 4);
  const ytdStart = `${year}-01-01`;
  const ytdIdx = findIndexOnOrAfter(sorted, ytdStart);
  const ytd = ytdIdx >= 0 && ytdIdx < sorted.length - 1
    ? pctReturn(sorted[ytdIdx].close, last.close)
    : null;

  // 成立以來：優先使用 inceptionPrice；否則用最早 K 棒
  let inception: number | null = null;
  if (etf.inceptionPrice && etf.inceptionPrice > 0) {
    inception = pctReturn(etf.inceptionPrice, last.close);
  } else {
    inception = pctReturn(sorted[0].close, last.close);
  }

  return {
    etfCode: etf.etfCode,
    etfName: etf.etfName,
    latestPrice: last.close,
    latestDate: last.date,
    inceptionDate: etf.inceptionDate,
    returns: { d1, w1, m1, ytd, inception },
  };
}

export type PeriodKey = keyof ETFPerformanceEntry['returns'];

export function rankByPeriod(
  entries: ETFPerformanceEntry[],
  period: PeriodKey,
): ETFPerformanceEntry[] {
  return [...entries].sort((a, b) => {
    const va = a.returns[period];
    const vb = b.returns[period];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return vb - va;
  });
}
