/**
 * L1 覆蓋率守門
 *
 * 用途：scan cron 在跑掃描前確認當日 L1 已完成下載。
 * 若覆蓋率不足，拒絕跑掃描以避免用殘缺資料覆蓋既有正確結果。
 *
 * 觸發場景（歷史教訓）：
 *   - 04-21 TW: download cron 出問題，TW 只下載 3% → daily scan 仍跑 → 寫了 4 支結果
 *     覆蓋了正確結果。後來 L1 修復後沒人發現掃描資料早已被殘缺版覆蓋。
 *   - 04-30 TW: scan cron 跑時 download-candles-batch 還沒完成 → BCDEF 全 0
 *
 * 此函式檢查 verify report (download-candles cron 結束才會寫)，
 * 若報告不存在 OR coverageRate < threshold，回傳 ok:false。
 */

import { loadVerifyReport } from '@/lib/datasource/DownloadVerifier';

export type CoverageCheck =
  | { ok: true; coverageRate: number; health: string }
  | { ok: false; reason: string; coverageRate: number };

const DEFAULT_MIN_COVERAGE = 0.95; // 95% L1 覆蓋率

export async function assertL1Coverage(
  market: 'TW' | 'CN',
  date: string,
  minCoverage: number = DEFAULT_MIN_COVERAGE,
): Promise<CoverageCheck> {
  const report = await loadVerifyReport(market, date);
  if (!report) {
    return {
      ok: false,
      reason: `verify-${market}-${date}.json 不存在 — 表示 download cron 尚未完成或失敗`,
      coverageRate: 0,
    };
  }
  const cr = report.summary.coverageRate;
  if (cr < minCoverage) {
    return {
      ok: false,
      reason: `L1 覆蓋率 ${(cr * 100).toFixed(1)}% < 門檻 ${(minCoverage * 100).toFixed(0)}% (health=${report.health})`,
      coverageRate: cr,
    };
  }
  return { ok: true, coverageRate: cr, health: report.health };
}
