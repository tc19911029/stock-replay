/**
 * findAnchorIndex — 根據訊號日 T 找到聚合 K 棒的 index + 日期範圍標籤
 */

import type { Candle } from '@/types';
import { getWeekMonday, getMonthKey } from './aggregateCandles';

export type ScanInterval = '1m' | '5m' | '15m' | '30m' | '60m' | '1d' | '1wk' | '1mo';

/** 分鐘K週期列表 */
export const MINUTE_INTERVALS: ScanInterval[] = ['1m', '5m', '15m', '30m', '60m'];

/** 每種週期對應的預設回看期間 */
export const DEFAULT_PERIODS: Record<ScanInterval, string> = {
  '1m': '5d', '5m': '60d', '15m': '60d', '30m': '60d', '60m': '6mo',
  '1d': '2y', '1wk': '5y', '1mo': '10y',
};

export interface AnchorResult {
  /** 聚合 K 棒陣列中的 index */
  index: number;
  /** 該 K 棒的日期字串（聚合後的 date） */
  anchorDate: string;
  /** 顯示用的日期範圍，如 "2026/03/16–2026/03/20" 或 "2026/03" */
  rangeLabel: string;
}

/** 格式化日期 "2026-03-16" → "2026/03/16" */
function fmtDate(d: string): string {
  return d.replace(/-/g, '/');
}

/**
 * 在聚合 K 棒陣列中找到訊號日 T 對應的 bar index 與範圍標籤
 */
export function findAnchorIndex(
  aggregatedCandles: Candle[],
  dailyCandles: Candle[],
  signalDate: string,
  interval: ScanInterval,
): AnchorResult | null {
  if (aggregatedCandles.length === 0) return null;

  // 分鐘K不需要聚合定位
  if (MINUTE_INTERVALS.includes(interval)) return null;

  if (interval === '1d') {
    // 精確日期或最近前一根
    let idx = aggregatedCandles.findIndex(c => c.date === signalDate);
    if (idx === -1) {
      for (let i = aggregatedCandles.length - 1; i >= 0; i--) {
        if (aggregatedCandles[i].date <= signalDate) { idx = i; break; }
      }
    }
    if (idx === -1) idx = aggregatedCandles.length - 1;
    return {
      index: idx,
      anchorDate: aggregatedCandles[idx].date,
      rangeLabel: fmtDate(aggregatedCandles[idx].date),
    };
  }

  if (interval === '1wk') {
    const targetMonday = getWeekMonday(signalDate);
    // aggregateCandles 用每週第一個交易日作為 date，找同一 Monday key 的
    let idx = -1;
    for (let i = 0; i < aggregatedCandles.length; i++) {
      if (getWeekMonday(aggregatedCandles[i].date) === targetMonday) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      // fallback: 找最近的前一根
      for (let i = aggregatedCandles.length - 1; i >= 0; i--) {
        if (aggregatedCandles[i].date <= signalDate) { idx = i; break; }
      }
    }
    if (idx === -1) idx = aggregatedCandles.length - 1;

    // 找這一週在 dailyCandles 裡的第一天和最後一天
    const weekDays = dailyCandles.filter(c => getWeekMonday(c.date) === targetMonday);
    const firstDay = weekDays.length > 0 ? weekDays[0].date : aggregatedCandles[idx].date;
    const lastDay = weekDays.length > 0 ? weekDays[weekDays.length - 1].date : firstDay;
    return {
      index: idx,
      anchorDate: aggregatedCandles[idx].date,
      rangeLabel: `${fmtDate(firstDay)}–${fmtDate(lastDay)}`,
    };
  }

  // interval === '1mo'
  const targetMonth = getMonthKey(signalDate);
  let idx = -1;
  for (let i = 0; i < aggregatedCandles.length; i++) {
    if (getMonthKey(aggregatedCandles[i].date) === targetMonth) {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    for (let i = aggregatedCandles.length - 1; i >= 0; i--) {
      if (aggregatedCandles[i].date <= signalDate) { idx = i; break; }
    }
  }
  if (idx === -1) idx = aggregatedCandles.length - 1;
  return {
    index: idx,
    anchorDate: aggregatedCandles[idx].date,
    rangeLabel: fmtDate(targetMonth), // "2026/03"
  };
}
