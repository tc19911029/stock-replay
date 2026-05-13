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
      // 2026-05-08：原 silent warn → alert + 自動觸發 download 救援
      // skip scan 是對的（避免用殘缺資料），但需告警 ops 並自我修復
      console.error(`[cron/scan-tw] ★★ 跳過 scan: ${coverage.reason} — 自動觸發 download-candles 救援`);
      const proto = req.headers.get('x-forwarded-proto') ?? 'https';
      const host = req.headers.get('host') ?? 'localhost:3000';
      const auth = req.headers.get('authorization') ?? '';
      fetch(`${proto}://${host}/api/cron/download-candles?market=TW`, { headers: { authorization: auth } })
        .catch(err => console.error('[cron/scan-tw] auto-trigger download failed:', err));
      return apiOk({
        skipped: true,
        alert: true,
        alertLevel: 'high',
        reason: 'l1-coverage-insufficient',
        detail: coverage.reason,
        coverageRate: coverage.coverageRate,
        action: 'auto-recovery-triggered',
        date,
      });
    }
    console.info(`[cron/scan-tw] L1 覆蓋率守門通過: ${(coverage.coverageRate * 100).toFixed(1)}% (health=${coverage.health})`);
  }

  try {
    // 0512 修：post-close 一次寫完所有 v12 買法 session（13 支字母）
    // 不再依賴 vercel.json update-intraday-bm per-letter cron（本地 launchd 不裝）
    // v11 G/H/I 已退場 — 不寫入新資料（舊資料 normalize-on-read 處理）
    const result = await runScanPipeline({
      market: 'TW',
      date,
      sessionType: 'post_close',
      directions: ['long', 'short'],
      mtfModes: ['daily', 'mtf'],
      buyMethods: ['B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'],
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
