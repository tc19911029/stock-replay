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
export function getWeekMonday(dateStr: string): string {
  // 2026-05-07 修：原 `T00:00:00` 是 local time，UTC+8 環境跑 toISOString() 會切回前一天
  // 例如本地週一 04-20 00:00 CST = UTC 04-19 16:00 → toISOString=2026-04-19 → 整週錯位。
  // 改用 UTC 中午（不會跨日）+ string-only 計算，跨時區結果穩定。
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().split('T')[0];
}

/** 取得月份 key（用於月K分組） — "YYYY-MM" */
export function getMonthKey(dateStr: string): string {
  return dateStr.substring(0, 7); // "2026-04"
}

/** 將一組同週期的日K聚合為單根K棒（date 用 keyFn 的回傳值，確保與 findAnchorIndex 比對一致） */
function mergeGroup(key: string, candles: Candle[], interval: string): Candle {
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

  // 月K時 key 為 "YYYY-MM"，需轉為 "YYYY-MM-01" 才能被 lightweight-charts 識別為有效日期
  const dateKey = interval === '1mo' ? `${key}-01` : key;
  return {
    date: dateKey,
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
  for (const [key, group] of groups) {
    result.push(mergeGroup(key, group, interval));
  }

  return result;
}
