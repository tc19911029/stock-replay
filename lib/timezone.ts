/**
 * 台灣時間工具函數 (UTC+8)
 * 全站統一使用此模組處理時間，確保一致性
 */

const TW_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 取得現在的台灣時間 Date 物件（注意：內部用 UTC 方法取值） */
export function nowTW(): Date {
  return new Date(Date.now() + TW_OFFSET_MS);
}

/** Unix timestamp (秒) → 台灣時間 ISO string "2026-03-27T09:30:00" */
export function unixToTW(ts: number): string {
  const d = new Date(ts * 1000 + TW_OFFSET_MS);
  return d.toISOString().slice(0, 19); // "2026-03-27T09:30:00"
}

/** Unix timestamp (毫秒) → 台灣時間 ISO string */
export function unixMsToTW(ms: number): string {
  const d = new Date(ms + TW_OFFSET_MS);
  return d.toISOString().slice(0, 19);
}

/** 取得今天的台灣日期 "2026-03-27" */
export function todayTW(): string {
  return nowTW().toISOString().slice(0, 10);
}

/** 取得現在的台灣時間 "14:30:05" */
export function nowTimeTW(): string {
  return nowTW().toISOString().slice(11, 19);
}

/** 取得現在的台灣時間 ISO string "2026-03-27T14:30:05" */
export function nowISOTW(): string {
  return nowTW().toISOString().slice(0, 19);
}

/** Date 物件 → 台灣時間 ISO string */
export function dateToTW(d: Date): string {
  const tw = new Date(d.getTime() + TW_OFFSET_MS);
  return tw.toISOString().slice(0, 19);
}

/** Date 物件 → 台灣日期 "2026-03-27" */
export function dateToTWDate(d: Date): string {
  const tw = new Date(d.getTime() + TW_OFFSET_MS);
  return tw.toISOString().slice(0, 10);
}

/** 台灣時間 ISO string → Unix timestamp (秒) */
export function twToUnix(twISO: string): number {
  // Parse as UTC then subtract 8 hours
  const utc = new Date(twISO + 'Z').getTime() - TW_OFFSET_MS;
  return Math.floor(utc / 1000);
}

/** 格式化台灣時間顯示 "下午 2:30:05" */
export function formatTWTime(twISO: string): string {
  const t = twISO.split('T')[1]?.slice(0, 8) ?? '';
  const [h, m, s] = t.split(':').map(Number);
  const period = h >= 12 ? '下午' : '上午';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${period}${h12}:${String(m).padStart(2, '0')}:${String(s ?? 0).padStart(2, '0')}`;
}

/** 格式化台灣時間顯示短版 "14:30" */
export function formatTWTimeShort(twISO: string): string {
  return twISO.split('T')[1]?.slice(0, 5) ?? '';
}

/** 格式化台灣日期顯示 "2026/03/27" */
export function formatTWDate(twISO: string): string {
  return twISO.split('T')[0]?.replace(/-/g, '/') ?? '';
}
