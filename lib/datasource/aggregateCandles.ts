/**
 * aggregateCandles — 將日K聚合為週K或月K
 *
 * 用於 FinMind / TWSE / 騰訊等僅提供日K的 provider，
 * 在取得日K後本地聚合為週K或月K。
 *
 * 聚合規則：
 *   open  = 該週期第一根日K的 open
 *   high  = 該週期所有日K的 max(high)
 *   low   = 該週期所有日K的 min(low)
 *   close = 該週期最後一根日K的 close
 *   volume = 該週期所有日K的 sum(volume)
 */

import type { Candle } from '@/types';

/**
 * 取得 ISO 週的週一日期字串（用於週K分組 key）
 * 例如 2026-04-02 (週四) → 2026-03-30 (該週的週一)
 */
function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? 6 : day - 1; // 距離週一的天數
  d.setDate(d.getDate() - diff);
  return d.toISOString().split('T')[0];
}

/** 取得月份 key（用於月K分組） — "YYYY-MM" */
function getMonthKey(dateStr: string): string {
  return dateStr.substring(0, 7); // "2026-04"
}

/** 將一組同週期的日K聚合為單根K棒 */
function mergeGroup(candles: Candle[]): Candle {
  const first = candles[0];
  const last = candles[candles.length - 1];
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;

  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    volume += c.volume;
  }

  return {
    date: first.date, // 用該週期第一個交易日的日期
    open: first.open,
    high: +high.toFixed(2),
    low: +low.toFixed(2),
    close: last.close,
    volume,
  };
}

/**
 * 將日K聚合為指定週期的K線
 *
 * @param dailyCandles 已按日期升序排列的日K陣列
 * @param interval '1d' | '1wk' | '1mo'
 * @returns 聚合後的K線陣列（仍按日期升序）
 */
export function aggregateCandles(dailyCandles: Candle[], interval?: string): Candle[] {
  if (!interval || interval === '1d') return dailyCandles;
  if (dailyCandles.length === 0) return [];

  const keyFn = interval === '1wk' ? getWeekMonday : getMonthKey;

  // 分組：保持插入順序
  const groups: Map<string, Candle[]> = new Map();
  for (const candle of dailyCandles) {
    const key = keyFn(candle.date);
    const group = groups.get(key);
    if (group) {
      group.push(candle);
    } else {
      groups.set(key, [candle]);
    }
  }

  // 聚合每組
  const result: Candle[] = [];
  for (const group of groups.values()) {
    result.push(mergeGroup(group));
  }

  return result;
}
