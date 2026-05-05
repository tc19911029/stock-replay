import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { runScanPipeline } from '@/lib/scanner/ScanPipeline';
import { assertL1Coverage } from '@/lib/scanner/coverageGuard';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam ?? getLastTradingDay('CN');

  if (!isTradingDay(date, 'CN')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  // 支援批次分割（Vercel 300s 限制）
  const batch = parseInt(req.nextUrl.searchParams.get('batch') ?? '0', 10) || undefined;
  const totalBatches = parseInt(req.nextUrl.searchParams.get('totalBatches') ?? '0', 10) || undefined;

  // L1 覆蓋率守門（CN 用較鬆的 90% 因為 EastMoney/Tencent 偶有缺漏）
  // 可用 ?force=1 強制跑（手動 backfill 場景）
  const force = req.nextUrl.searchParams.get('force') === '1';
  if (!force) {
    const coverage = await assertL1Coverage('CN', date, 0.90);
    if (!coverage.ok) {
      console.warn(`[cron/scan-cn] ★ 跳過 scan: ${coverage.reason}`);
      return apiOk({
        skipped: true,
        reason: 'l1-coverage-insufficient',
        detail: coverage.reason,
        coverageRate: coverage.coverageRate,
        date,
      });
    }
    console.info(`[cron/scan-cn] L1 覆蓋率守門通過: ${(coverage.coverageRate * 100).toFixed(1)}% (health=${coverage.health})`);
  }

  try {
    const result = await runScanPipeline({
      market: 'CN',
      date,
      sessionType: 'post_close',
      directions: ['long', 'short'],
      mtfModes: ['daily', 'mtf'],
      force: true,
      batch,
      totalBatches,
    });

    const alert = (result.counts['long-daily'] ?? 0) === 0;
    if (alert) {
      console.warn(`[cron/scan-cn] ★ 交易日 ${date} long-daily 0 筆`);
    }

    return apiOk({
      ...result,
      ...(alert && { alert: true, warning: `交易日 ${date} long-daily 0 筆` }),
    });
  } catch (err) {
    return apiError(String(err));
  }
}
