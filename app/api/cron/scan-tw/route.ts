import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { runScanPipeline } from '@/lib/scanner/ScanPipeline';
import { assertL1Coverage } from '@/lib/scanner/coverageGuard';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  // TEMP bypass
  // const authHeader = req.headers.get('authorization');
  // if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return apiError('Unauthorized', 401);
  // }

  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam ?? getLastTradingDay('TW');

  if (!isTradingDay(date, 'TW')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  // L1 覆蓋率守門：若 download 未完成或殘缺，拒絕跑 scan，避免覆蓋既有正確結果
  // 可用 ?force=1 強制跑（手動 backfill 場景）
  const force = req.nextUrl.searchParams.get('force') === '1';
  if (!force) {
    const coverage = await assertL1Coverage('TW', date);
    if (!coverage.ok) {
      console.warn(`[cron/scan-tw] ★ 跳過 scan: ${coverage.reason}`);
      return apiOk({
        skipped: true,
        reason: 'l1-coverage-insufficient',
        detail: coverage.reason,
        coverageRate: coverage.coverageRate,
        date,
      });
    }
    console.info(`[cron/scan-tw] L1 覆蓋率守門通過: ${(coverage.coverageRate * 100).toFixed(1)}% (health=${coverage.health})`);
  }

  try {
    const result = await runScanPipeline({
      market: 'TW',
      date,
      sessionType: 'post_close',
      directions: ['long', 'short'],
      mtfModes: ['daily', 'mtf'],
      force: true,
    });

    const alert = (result.counts['long-daily'] ?? 0) === 0;
    if (alert) {
      console.warn(`[cron/scan-tw] ★ 交易日 ${date} long-daily 0 筆`);
    }

    return apiOk({
      ...result,
      ...(alert && { alert: true, warning: `交易日 ${date} long-daily 0 筆` }),
    });
  } catch (err) {
    return apiError(String(err));
  }
}
