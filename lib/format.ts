/**
 * 全站數字／日期格式統一工具。
 * 任何頁面顯示價格、百分比、張數、日期一律從這裡取，避免 .toFixed / toLocaleString 散落各處。
 */

/** 價格：固定 2 位小數 + $ 前綴。`null/undefined/0` 回傳 `—`。 */
export function formatPrice(value: number | null | undefined, withDollar = true): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '—';
  const s = value.toFixed(2);
  return withDollar ? `$${s}` : s;
}

/** 百分比：固定 2 位小數 + 強制 +/- 號 + `%`。 */
export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

/** 成交量（股數）→ 張數，1 張 = 1000 股。 */
export function formatShares(shares: number | null | undefined): string {
  if (shares == null || !Number.isFinite(shares)) return '—';
  return `${Math.round(shares / 1000).toLocaleString('zh-TW')}張`;
}

/** 大數字：自動加千分位。 */
export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-TW');
}

/** 日期：`YYYY/M/D`（zh-TW 慣例）。輸入接受 ISO 字串或 Date。 */
export function formatDate(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('zh-TW');
}

/** 時間：`HH:MM`（24h）。 */
export function formatTime(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 漲跌色 class（台股慣例：紅漲綠跌）。 */
export function bullBearClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-muted-foreground';
  return value >= 0 ? 'text-bull' : 'text-bear';
}
