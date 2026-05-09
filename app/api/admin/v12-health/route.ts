/**
 * GET /api/admin/v12-health
 *
 * v12 系統綜合健康檢查 — production ops monitor 用
 *
 * 回傳：
 * - latestScanDates: 各市場各 v12 字母 latest scan date
 * - lockWatchCounts: TW/CN active records by stage
 * - todayCoverage: 今日 production 覆蓋率（多少 v12 字母有跑）
 * - alertLevel: 'ok' | 'warn' | 'critical'
 *
 * 範例使用：
 *   curl -H 'x-admin-secret: $ADMIN_SECRET' https://stock-replay-5f24.vercel.app/api/admin/v12-health
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkAdminAuth } from '@/lib/api/adminAuth';
import { listScanDates } from '@/lib/storage/scanStorage';
import { loadLatestLockWatchSnapshot } from '@/lib/storage/lockWatchStorage';
import type { MarketId, MtfMode } from '@/lib/scanner/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const V12_LETTERS: MtfMode[] = ['B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'];

interface MarketHealth {
  market: MarketId;
  latestScans: Record<string, string | null>;  // letter → latest date
  daysSinceLastScan: Record<string, number | null>;
  todayCoverage: { letterCount: number; total: number; pct: number };
  lockWatch: {
    latestDate: string | null;
    totalRecords: number;
    byStage: Record<string, number>;
    byTrigger: Record<string, number>;
  };
}

async function checkMarket(market: MarketId, today: string): Promise<MarketHealth> {
  const latestScans: Record<string, string | null> = {};
  const daysSinceLastScan: Record<string, number | null> = {};
  let lettersToday = 0;

  for (const letter of V12_LETTERS) {
    const dates = await listScanDates(market, 'long', letter);
    const latest = dates.length > 0 ? dates[0].date : null;
    latestScans[letter] = latest;
    if (latest) {
      const daysDiff = Math.floor((new Date(today).getTime() - new Date(latest).getTime()) / 86400_000);
      daysSinceLastScan[letter] = daysDiff;
      if (daysDiff === 0) lettersToday++;
    } else {
      daysSinceLastScan[letter] = null;
    }
  }

  // LockWatch
  const lwSnap = await loadLatestLockWatchSnapshot(market);
  const byStage: Record<string, number> = {};
  const byTrigger: Record<string, number> = {};
  if (lwSnap) {
    for (const r of lwSnap.records) {
      byStage[r.currentStage] = (byStage[r.currentStage] ?? 0) + 1;
      byTrigger[r.triggerSignal] = (byTrigger[r.triggerSignal] ?? 0) + 1;
    }
  }

  return {
    market,
    latestScans,
    daysSinceLastScan,
    todayCoverage: {
      letterCount: lettersToday,
      total: V12_LETTERS.length,
      pct: +((lettersToday / V12_LETTERS.length) * 100).toFixed(1),
    },
    lockWatch: {
      latestDate: lwSnap?.date ?? null,
      totalRecords: lwSnap?.records.length ?? 0,
      byStage,
      byTrigger,
    },
  };
}

export async function GET(req: NextRequest) {
  const denied = checkAdminAuth(req);
  if (denied) return denied;

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

  try {
    const [tw, cn] = await Promise.all([
      checkMarket('TW', today),
      checkMarket('CN', today),
    ]);

    // Alert level
    const twCoverage = tw.todayCoverage.pct;
    const cnCoverage = cn.todayCoverage.pct;
    let alertLevel: 'ok' | 'warn' | 'critical' = 'ok';
    // 用 CST 時區判斷週末：`new Date('YYYY-MM-DD')` 是 UTC 午夜，
    // 在 Vercel UTC 上 toString 會用 server local timezone，週六/週日邊界誤判
    const cstDow = new Date(today + 'T00:00:00+08:00').getUTCDay(); // 0=Sun, 6=Sat
    const isWeekend = cstDow === 0 || cstDow === 6;
    if (!isWeekend) {
      if (twCoverage < 50 || cnCoverage < 50) alertLevel = 'critical';
      else if (twCoverage < 100 || cnCoverage < 100) alertLevel = 'warn';
    }

    return apiOk({
      generatedAt: new Date().toISOString(),
      today,
      isWeekend,
      alertLevel,
      markets: { TW: tw, CN: cn },
    });
  } catch (err) {
    console.error('[admin/v12-health]', err);
    return apiError(`failed: ${String(err).slice(0, 200)}`);
  }
}
