/**
 * marketHours.ts — 市場開盤時間判斷
 *
 * 從 MultiMarketProvider 的邏輯提取，供 scanner chunk route 等模組使用。
 * 防止盤前/盤後使用昨日即時報價建立假的今日 K 棒。
 */

import { isTradingDay } from '@/lib/utils/tradingDay';

function getLocalTime(tz: string): { hour: number; min: number; dow: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
  }).format(now).replace(/\u202f/g, ' ').split(':');
  const hour = parseInt(parts[0], 10);
  const min = parseInt(parts[1], 10);
  const DOW_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
  const dow = DOW_MAP[dayStr] ?? 1;
  return { hour, min, dow };
}

/** 台股是否在盤中（09:00–13:30，週一～五，且非假日） */
export function isTWMarketOpen(): boolean {
  const { hour, min, dow } = getLocalTime('Asia/Taipei');
  if (dow === 0 || dow === 6) return false;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  if (!isTradingDay(today, 'TW')) return false;
  const timeMin = hour * 60 + min;
  return timeMin >= 540 && timeMin <= 810; // 09:00 ~ 13:30
}

/** A 股是否在盤中（09:15–15:00，週一～五，且非假日） */
export function isCNMarketOpen(): boolean {
  const { hour, min, dow } = getLocalTime('Asia/Shanghai');
  if (dow === 0 || dow === 6) return false;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  if (!isTradingDay(today, 'CN')) return false;
  const timeMin = hour * 60 + min;
  return timeMin >= 555 && timeMin <= 900; // 09:15 ~ 15:00
}

/** 根據市場代碼判斷是否開盤 */
export function isMarketOpen(market: 'TW' | 'CN'): boolean {
  return market === 'TW' ? isTWMarketOpen() : isCNMarketOpen();
}

/**
 * 取得最後一個交易日（跳過週末）
 * 用於盤前/盤後掃描時降級為歷史掃描
 *
 * 邏輯：
 *   - 盤後（收盤後 ~ 午夜）→ 今天就是最後交易日
 *   - 盤前（午夜 ~ 開盤前）→ 上一個工作日
 *   - 週末 → 上週五
 *
 * 注意：不考慮節假日（無可靠的假日曆），最多差一天，
 * 在掃描端由 loadLocalCandlesWithTolerance 容忍度吸收。
 */
export function getLastTradingDay(market: 'TW' | 'CN'): string {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  const { hour, min, dow } = getLocalTime(tz);
  const timeMin = hour * 60 + min;

  // 精確收盤時間（不加緩衝，收盤後立即認定為當日最後交易日）
  const closeTime = market === 'TW' ? 810 : 900; // TW: 13:30, CN: 15:00

  const now = new Date();
  // 取得市場時區的「今天」日期字串
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); // YYYY-MM-DD

  // 如果是交易日且已收盤 → 今天就是最後交易日
  if (dow >= 1 && dow <= 5 && timeMin >= closeTime && isTradingDay(localDate, market)) {
    return localDate;
  }

  // 否則回推到上一個交易日（跳過週末 + 假日）
  const d = new Date(localDate + 'T12:00:00'); // noon to avoid DST edge cases
  if (dow === 0) {
    d.setDate(d.getDate() - 2); // 週日 → 上週五
  } else if (dow === 6) {
    d.setDate(d.getDate() - 1); // 週六 → 上週五
  } else if (timeMin < closeTime) {
    // 工作日盤前 → 上一個工作日
    if (dow === 1) {
      d.setDate(d.getDate() - 3);
    } else {
      d.setDate(d.getDate() - 1);
    }
  }

  // 持續回退直到找到交易日（跳過假日）
  let result = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  let safety = 10; // 防止無窮迴圈（最多回退10天）
  while (!isTradingDay(result, market) && safety-- > 0) {
    d.setDate(d.getDate() - 1);
    result = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  }

  return result;
}
