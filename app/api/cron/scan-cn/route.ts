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
      // 2026-05-08：原 silent warn → alert + 自動觸發 download-batch 救援
      console.error(`[cron/scan-cn] ★★ 跳過 scan: ${coverage.reason} — 自動觸發 download-candles-batch 救援`);
      const proto = req.headers.get('x-forwarded-proto') ?? 'https';
      const host = req.headers.get('host') ?? 'localhost:3000';
      const auth = req.headers.get('authorization') ?? '';
      // CN 走 batch 1（含大盤指數補漏 + 第一批個股）
      fetch(`${proto}://${host}/api/cron/download-candles-batch?market=CN&batch=1&totalBatches=8`, { headers: { authorization: auth } })
        .catch(err => console.error('[cron/scan-cn] auto-trigger download failed:', err));
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
    console.info(`[cron/scan-cn] L1 覆蓋率守門通過: ${(coverage.coverageRate * 100).toFixed(1)}% (health=${coverage.health})`);
  }

  try {
    // 0512 修：post-close 一次寫完所有 v12 買法 session（13 支字母）
    // 不再依賴 vercel.json update-intraday-bm per-letter cron（本地 launchd 不裝）
    // v11 G/H/I 已退場 — 不寫入新資料（舊資料 normalize-on-read 處理）
    const result = await runScanPipeline({
      market: 'CN',
      date,
      sessionType: 'post_close',
      directions: ['long', 'short'],
      mtfModes: ['daily', 'mtf'],
      buyMethods: ['B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'],
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
