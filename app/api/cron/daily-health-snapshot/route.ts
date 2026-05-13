/**
 * Daily Health Snapshot
 *
 * 每日盤後固化「資料健康狀態」快照到本地檔，給用戶 UI 一頁紙看。
 *
 * GET /api/cron/daily-health-snapshot           （兩市場都跑）
 * GET /api/cron/daily-health-snapshot?market=TW
 *
 * 排程建議：
 *   TW: 14:30 CST（盤後 download/append 之後 30 分鐘，給 verify 報告寫入時間）
 *   CN: 16:30 CST（同上）
 *
 * 輸出：data/health-snapshot/health-{date}.json
 *   含兩市場聚合的健康度 + L1 verify summary + L2 fresh + L4 scan + alert level
 */

import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';
export const maxDuration = 30;

const SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'health-snapshot');

function getBaseUrl(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') ?? 'http';
  const host = req.headers.get('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}

function authHeader(): Record<string, string> {
  if (process.env.CRON_SECRET) {
    return { authorization: `Bearer ${process.env.CRON_SECRET}` };
  }
  return {};
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
}

interface HealthFetchResult {
  ok: boolean;
  market: 'TW' | 'CN';
  health: string;
  reportDate: string | null;
  coverageRate: number | null;
  stocksWithGaps: number | null;
  stocksStale: number | null;
  downloadFailed: number | null;
  l2Status: string;
  l2Count: number | null;
  l2AgeSec: number | null;
  l2AlertLevel: string;
  l4Status: string;
  l4LastDate: string | null;
  l4ResultCount: number;
  /** Limit-up 一致性檢查：抓「假裝沒漲跌」的 quote */
  limitUpConsistencyLevel: string;
  limitUpConsistencySuspicious: number;
  raw: unknown;
}

async function fetchMarketHealth(baseUrl: string, market: 'TW' | 'CN'): Promise<HealthFetchResult> {
  const url = `${baseUrl}/api/health/data?market=${market}&detail=1`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) {
    return {
      ok: false, market,
      health: 'fetch_error',
      reportDate: null, coverageRate: null, stocksWithGaps: null, stocksStale: null, downloadFailed: null,
      l2Status: 'unknown', l2Count: null, l2AgeSec: null, l2AlertLevel: 'unknown',
      l4Status: 'unknown', l4LastDate: null, l4ResultCount: 0,
      limitUpConsistencyLevel: 'unknown', limitUpConsistencySuspicious: 0,
      raw: { error: `HTTP ${res.status}` },
    };
  }
  const data = await res.json() as {
    ok?: boolean;
    market?: 'TW' | 'CN';
    health?: string;
    reportDate?: string | null;
    coverageRate?: number | null;
    stocksWithGaps?: number | null;
    stocksStale?: number | null;
    downloadFailed?: number | null;
    l2?: { status?: string; quoteCount?: number | null; ageSeconds?: number | null };
    l2Sources?: { alertLevel?: string };
    l4?: { status?: string; lastScanDate?: string | null; lastScanCount?: number };
    limitUpConsistency?: { level?: string; suspicious?: number };
  };

  return {
    ok: true, market,
    health: data.health ?? 'unknown',
    reportDate: data.reportDate ?? null,
    coverageRate: data.coverageRate ?? null,
    stocksWithGaps: data.stocksWithGaps ?? null,
    stocksStale: data.stocksStale ?? null,
    downloadFailed: data.downloadFailed ?? null,
    l2Status: data.l2?.status ?? 'unknown',
    l2Count: data.l2?.quoteCount ?? null,
    l2AgeSec: data.l2?.ageSeconds ?? null,
    l2AlertLevel: data.l2Sources?.alertLevel ?? 'unknown',
    l4Status: data.l4?.status ?? 'unknown',
    l4LastDate: data.l4?.lastScanDate ?? null,
    l4ResultCount: data.l4?.lastScanCount ?? 0,
    limitUpConsistencyLevel: data.limitUpConsistency?.level ?? 'ok',
    limitUpConsistencySuspicious: data.limitUpConsistency?.suspicious ?? 0,
    raw: data,
  };
}

/**
 * 把多個 health 信號折成一個總體燈號：
 *   green: 全部 fresh + 無 stale + 無 gap
 *   yellow: 部分 stale 或 partial（仍可用，但要盯）
 *   red: 報告 critical / coverage < 90% / 大量 stocksStale
 */
function deriveOverallLevel(items: HealthFetchResult[]): 'green' | 'yellow' | 'red' {
  let red = 0, yellow = 0;
  for (const it of items) {
    if (!it.ok) { red++; continue; }
    // L1 verify report 等級
    if (it.health === 'critical' || it.health === 'no_report') red++;
    else if (it.health === 'warning') yellow++;
    // coverage
    if (it.coverageRate != null && it.coverageRate < 0.90) red++;
    else if (it.coverageRate != null && it.coverageRate < 0.97) yellow++;
    // stale 數量
    if ((it.stocksStale ?? 0) > 200) red++;
    else if ((it.stocksStale ?? 0) > 50) yellow++;
    // L2 alert level
    if (it.l2AlertLevel === 'critical') red++;
    else if (it.l2AlertLevel === 'warning') yellow++;
    // Limit-up 一致性：任何「假裝沒漲跌」都是嚴重訊號（資料源 close resolver 出包）
    if (it.limitUpConsistencyLevel === 'critical') red++;
    else if (it.limitUpConsistencyLevel === 'warning') yellow++;
  }
  if (red > 0) return 'red';
  if (yellow > 0) return 'yellow';
  return 'green';
}

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const marketParam = req.nextUrl.searchParams.get('market') as 'TW' | 'CN' | null;
  const baseUrl = getBaseUrl(req);

  try {
    await ensureDir();

    const targets: ('TW' | 'CN')[] = marketParam ? [marketParam] : ['TW', 'CN'];
    const results = await Promise.all(targets.map(m => fetchMarketHealth(baseUrl, m)));

    const overall = deriveOverallLevel(results);

    // 用最早觸發的市場 lastTradingDay 當檔名 key（兩市場可能相差 1 天，取較早者較穩）
    const dateKey = getLastTradingDay(targets[0]);
    const filename = `health-${dateKey}.json`;
    const fullPath = path.join(SNAPSHOT_DIR, filename);

    // 若已存在當天 snapshot：merge（保留另一市場的最新狀態）
    let existing: { markets?: HealthFetchResult[]; generatedAt?: string } = {};
    try {
      const raw = await fs.readFile(fullPath, 'utf-8');
      existing = JSON.parse(raw);
    } catch { /* 第一次跑 */ }

    const mergedMarkets: HealthFetchResult[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      mergedMarkets.push(r);
      seen.add(r.market);
    }
    for (const old of (existing.markets ?? [])) {
      if (!seen.has(old.market)) mergedMarkets.push(old);
    }

    const snapshot = {
      version: 1,
      dateKey,
      generatedAt: new Date().toISOString(),
      overall,
      markets: mergedMarkets,
    };

    await atomicFsPut(fullPath, JSON.stringify(snapshot, null, 2));

    console.log(`[daily-health] 寫入 ${filename} overall=${overall}`);

    // ── Alert webhook（紅燈/黃燈推通知，靠 HEALTH_ALERT_WEBHOOK_URL env）─────
    // 設計：simple POST，payload 為 markdown-friendly text，幾乎任何 webhook 都可接
    // （Slack incoming webhook、Discord、IFTTT Maker、ntfy.sh、自建 endpoint…）。
    // 沒設 env 就 skip；webhook 失敗不擋 cron。
    // 觸發門檻可透過 HEALTH_ALERT_LEVEL='red' (預設) | 'yellow' 調整。
    const webhookUrl = process.env.HEALTH_ALERT_WEBHOOK_URL;
    const alertThreshold = (process.env.HEALTH_ALERT_LEVEL ?? 'red') as 'red' | 'yellow';
    const shouldAlert =
      webhookUrl &&
      (overall === 'red' || (overall === 'yellow' && alertThreshold === 'yellow'));
    if (shouldAlert) {
      const lines: string[] = [
        `🚨 RockStock 資料健康警示 — ${dateKey} ${overall.toUpperCase()}`,
      ];
      for (const r of results) {
        const coverPct = r.coverageRate != null ? `${(r.coverageRate * 100).toFixed(1)}%` : 'n/a';
        lines.push(
          `${r.market}: L1=${r.health}/${coverPct} stale=${r.stocksStale ?? '?'} ` +
            `L2=${r.l2Status}/${r.l2AlertLevel} L4=${r.l4Status} ` +
            `limitUp=${r.limitUpConsistencyLevel}(${r.limitUpConsistencySuspicious})`,
        );
      }
      const text = lines.join('\n');
      try {
        const alertRes = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, level: overall, dateKey, markets: results }),
        });
        if (alertRes.ok) {
          console.log(`[daily-health] alert webhook posted (${overall})`);
        } else {
          console.warn(`[daily-health] alert webhook HTTP ${alertRes.status}`);
        }
      } catch (err) {
        console.warn(`[daily-health] alert webhook failed:`, err);
      }
    }

    return apiOk({
      snapshot: {
        dateKey,
        overall,
        marketsCount: mergedMarkets.length,
        path: fullPath,
      },
      summary: results.map(r => ({
        market: r.market,
        health: r.health,
        coverageRate: r.coverageRate,
        stocksStale: r.stocksStale,
        l2Status: r.l2Status,
        l2AlertLevel: r.l2AlertLevel,
        limitUpConsistencyLevel: r.limitUpConsistencyLevel,
        limitUpConsistencySuspicious: r.limitUpConsistencySuspicious,
      })),
    });
  } catch (err) {
    console.error('[daily-health] error:', err);
    return apiError(String(err));
  }
}
