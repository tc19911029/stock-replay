/**
 * Auto-repair watchdog
 *
 * 在主下載 cron 跑完後（約 15 分鐘）執行：
 *   1. 讀最新 verify 報告
 *   2. 如果 stocksStale > STALE_THRESHOLD 或 coverageRate < COVERAGE_THRESHOLD
 *      → 自動 fire retry-failed cron（不等回應，讓它在後台跑）
 *
 * 避免大規模缺漏需要人工發現的情境（如 04-23 缺 975 支）。
 *
 * GET /api/cron/auto-repair-watchdog?market=TW
 * GET /api/cron/auto-repair-watchdog?market=CN
 *
 * 排程建議（vercel.json）：
 *   TW: 06:00 UTC (14:00 CST，主下載 13:45 CST 之後 15 分鐘)
 *   CN: 07:50 UTC (15:50 CST，CN 批次最後一批 15:33 CST 之後 17 分鐘)
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { loadVerifyReport } from '@/lib/datasource/DownloadVerifier';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { checkCronAuth } from '@/lib/api/cronAuth';

export const runtime = 'nodejs';
export const maxDuration = 30;

const STALE_THRESHOLD = 50;          // > 50 支 stale 就觸發
const COVERAGE_THRESHOLD = 0.97;     // < 97% 覆蓋率就觸發
const ZOMBIE_DAYS_THRESHOLD = 90;    // L1 落後 > N 天視為殭屍候選（疑似退市/合併）

function getBaseUrl(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') ?? 'http';
  const host = req.headers.get('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const market = (req.nextUrl.searchParams.get('market') as 'TW' | 'CN') ?? 'TW';
  if (market !== 'TW' && market !== 'CN') {
    return apiError('market must be TW or CN', 400);
  }

  const lastTrading = getLastTradingDay(market);

  // ── 讀最近 7 天的 verify 報告（最新一份）──
  let report: Awaited<ReturnType<typeof loadVerifyReport>> = null;
  let reportDate = '';
  for (let daysBack = 0; daysBack < 7; daysBack++) {
    const d = new Date(lastTrading + 'T12:00:00');
    d.setDate(d.getDate() - daysBack);
    const dateStr = d.toISOString().split('T')[0];
    const r = await loadVerifyReport(market, dateStr);
    if (r) {
      report = r;
      reportDate = dateStr;
      break;
    }
  }

  if (!report) {
    return apiOk({ market, action: 'skipped', reason: '找不到 verify 報告' });
  }

  const { stocksStale, coverageRate } = report.summary;
  const needsRepair = stocksStale > STALE_THRESHOLD || coverageRate < COVERAGE_THRESHOLD;

  // ── 殭屍 L1 偵測（疑似退市/合併但 L1 沒清掉）──
  // staleDetails 裡 daysBehind > 90 = 三個月沒更新，幾乎確定不是抓取問題
  const zombies = (report.staleDetails ?? []).filter(s => s.daysBehind > ZOMBIE_DAYS_THRESHOLD);
  if (zombies.length > 0) {
    console.warn(
      `[auto-repair-watchdog] ${market} 偵測 ${zombies.length} 支殭屍 L1（落後 > ${ZOMBIE_DAYS_THRESHOLD} 天）— ` +
      `跑 scripts/verify-cn-stale.ts 雙源驗證後可用 prune-cn-delisted.ts 歸檔。範例: ` +
      zombies.slice(0, 5).map(z => `${z.symbol}(${z.daysBehind}d)`).join(', ') +
      (zombies.length > 5 ? ` ... +${zombies.length - 5}` : '')
    );
  }

  if (!needsRepair) {
    return apiOk({
      market,
      action: 'no_repair_needed',
      reportDate,
      stocksStale,
      coverageRate,
      zombies: zombies.length,
    });
  }

  // ── 觸發 retry-failed（fire-and-forget） ──
  const baseUrl = getBaseUrl(req);
  const retryUrl = `${baseUrl}/api/cron/retry-failed?market=${market}`;
  const headers: Record<string, string> = {};
  if (process.env.CRON_SECRET) {
    headers['authorization'] = `Bearer ${process.env.CRON_SECRET}`;
  }

  console.log(
    `[auto-repair-watchdog] ${market} 需要修復: stale=${stocksStale} coverage=${coverageRate} → 觸發 retry-failed`
  );

  // 不 await — 讓 retry-failed 自己跑，watchdog 立刻回應
  fetch(retryUrl, { headers })
    .then(r => r.json())
    .then(j => console.log(`[auto-repair-watchdog] ${market} retry-failed 完成:`, JSON.stringify(j).slice(0, 200)))
    .catch(err => console.error(`[auto-repair-watchdog] ${market} retry-failed 失敗:`, err));

  return apiOk({
    market,
    action: 'triggered_retry',
    reportDate,
    stocksStale,
    coverageRate,
    zombies: zombies.length,
    retryUrl,
  });
}
