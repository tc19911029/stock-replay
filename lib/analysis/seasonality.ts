/**
 * Calendar Seasonality Effects
 *
 * Captures well-documented calendar anomalies in Asian stock markets:
 *
 * 1. 月底投信作帳效應 (Month-end window dressing):
 *    - Last 5 trading days: investment trusts buy to pump holdings
 *    - Especially strong at quarter-end (Mar, Jun, Sep, Dec)
 *    - Effect: +2-5% boost for institutional favorites
 *
 * 2. 月初獲利了結 (Month-start profit taking):
 *    - First 2-3 trading days: selling pressure after window dressing
 *
 * 3. 除權息行情 (Ex-dividend season, Jul-Sep):
 *    - High-dividend stocks tend to fill the gap
 *
 * 4. 農曆新年前效應 (Pre-Lunar New Year rally):
 *    - 2 weeks before CNY: historically bullish
 *
 * Returns a composite adjustment to signal timing quality.
 */

export interface SeasonalityResult {
  /** Calendar effect strength: -10 to +10 */
  adjustment: number;
  /** Active effects */
  effects: string[];
  /** Whether this is a historically favorable entry period */
  favorable: boolean;
}

/**
 * Compute calendar seasonality adjustment for a given date.
 */
export function computeSeasonality(
  dateStr: string,
  market: 'TW' | 'CN' = 'TW',
): SeasonalityResult {
  const date = new Date(dateStr);
  const month = date.getMonth() + 1; // 1-12
  const dayOfMonth = date.getDate();
  const dayOfWeek = date.getDay(); // 0=Sun, 5=Fri

  // Get last day of month
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const daysUntilMonthEnd = lastDay - dayOfMonth;

  let adjustment = 0;
  const effects: string[] = [];

  // ── 1. Month-end window dressing (投信作帳) ─────────────────────────────
  // Last 5 trading days of month
  if (daysUntilMonthEnd <= 7) { // ~5 trading days ≈ 7 calendar days
    const isQuarterEnd = [3, 6, 9, 12].includes(month);

    if (isQuarterEnd) {
      adjustment += 5;
      effects.push(`季底作帳 (Q${Math.ceil(month / 3)} end)`);
    } else {
      adjustment += 3;
      effects.push('月底作帳期');
    }
  }

  // ── 2. Month-start profit taking ────────────────────────────────────────
  if (dayOfMonth <= 3) {
    const isPrevQuarterEnd = [1, 4, 7, 10].includes(month);
    if (isPrevQuarterEnd) {
      adjustment -= 3;
      effects.push('季初獲利了結');
    } else {
      adjustment -= 1;
      effects.push('月初賣壓');
    }
  }

  // ── 3. Year-end rally (聖誕節 + 新年行情) ─────────────────────────────
  if (month === 12 && dayOfMonth >= 20) {
    adjustment += 3;
    effects.push('年底行情');
  }

  // ── 4. January effect ──────────────────────────────────────────────────
  if (month === 1 && dayOfMonth <= 15) {
    adjustment += 2;
    effects.push('元月效應');
  }

  // ── 5. Friday effect (台股週五偏空) ────────────────────────────────────
  if (market === 'TW' && dayOfWeek === 5) {
    adjustment -= 1;
    effects.push('週五效應');
  }

  // ── 6. Ex-dividend season (除權息行情, Jul-Sep for TW) ─────────────────
  if (market === 'TW' && month >= 7 && month <= 9) {
    adjustment += 1;
    effects.push('除權息旺季');
  }

  // ── 7. A-share specific: National Day golden week anticipation ─────────
  if (market === 'CN' && month === 9 && dayOfMonth >= 20) {
    adjustment += 2;
    effects.push('國慶行情預期');
  }

  // Cap adjustment
  adjustment = Math.max(-10, Math.min(10, adjustment));

  return {
    adjustment,
    effects,
    favorable: adjustment >= 2,
  };
}
