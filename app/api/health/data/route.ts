/**
 * 數據健康狀態 API
 *
 * GET /api/health/data?market=TW
 * GET /api/health/data?market=CN
 * GET /api/health/data              （兩個市場都返回）
 *
 * 讀取 DownloadVerifier 生成的校驗報告 + L2 快照新鮮度。
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { loadVerifyReport, type VerifyReport } from '@/lib/datasource/DownloadVerifier';
import { readIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';

interface L2Status {
  /** fresh / stale / missing */
  status: 'fresh' | 'stale' | 'missing';
  /** 快照中的報價數量 */
  quoteCount: number | null;
  /** 快照年齡（秒） */
  ageSeconds: number | null;
  /** 快照更新時間 */
  updatedAt: string | null;
}

interface MarketHealth {
  market: 'TW' | 'CN';
  /** 最新校驗報告日期 */
  reportDate: string | null;
  /** good / warning / critical / no_report */
  health: string;
  /** 覆蓋率 0-1 */
  coverageRate: number | null;
  /** 有 gap 的股票數 */
  stocksWithGaps: number | null;
  /** 數據過期的股票數 */
  stocksStale: number | null;
  /** 下載失敗的股票數 */
  downloadFailed: number | null;
  /** 報告生成時間 */
  generatedAt: string | null;
  /** L2 快照新鮮度 */
  l2: L2Status;
  /** 完整報告（可選，?detail=1 時返回） */
  report?: VerifyReport;
}

function getTodayDate(market: 'TW' | 'CN'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
  }).format(new Date());
}

async function getL2Status(market: 'TW' | 'CN'): Promise<L2Status> {
  const today = getTodayDate(market);
  const snapshot = await readIntradaySnapshot(market, today);

  if (!snapshot || snapshot.count === 0) {
    return { status: 'missing', quoteCount: null, ageSeconds: null, updatedAt: null };
  }

  const ageMs = Date.now() - new Date(snapshot.updatedAt).getTime();
  const ageSeconds = Math.round(ageMs / 1000);

  // fresh: <5分鐘 | stale: 5-30分鐘 | missing: >30分鐘
  let status: L2Status['status'] = 'fresh';
  if (ageSeconds > 30 * 60) {
    status = 'missing';
  } else if (ageSeconds > 5 * 60) {
    status = 'stale';
  }

  return {
    status,
    quoteCount: snapshot.count,
    ageSeconds,
    updatedAt: snapshot.updatedAt,
  };
}

async function getMarketHealth(
  market: 'TW' | 'CN',
  includeDetail: boolean,
): Promise<MarketHealth> {
  const lastTrading = getLastTradingDay(market);

  // L2 快照狀態（並行讀取）
  const l2Promise = getL2Status(market);

  // 嘗試讀取最近 3 天的報告（可能假日沒報告）
  let l1Result: Omit<MarketHealth, 'l2'> | null = null;
  for (let daysBack = 0; daysBack < 3; daysBack++) {
    const d = new Date(lastTrading + 'T12:00:00');
    d.setDate(d.getDate() - daysBack);
    const dateStr = d.toISOString().split('T')[0];

    const report = await loadVerifyReport(market, dateStr);
    if (report) {
      l1Result = {
        market,
        reportDate: dateStr,
        health: report.health,
        coverageRate: report.summary.coverageRate,
        stocksWithGaps: report.summary.stocksWithGaps,
        stocksStale: report.summary.stocksStale,
        downloadFailed: report.summary.downloadFailed,
        generatedAt: report.generatedAt,
        report: includeDetail ? report : undefined,
      };
      break;
    }
  }

  const l2 = await l2Promise;

  if (l1Result) {
    return { ...l1Result, l2 };
  }

  return {
    market,
    reportDate: null,
    health: 'no_report',
    coverageRate: null,
    stocksWithGaps: null,
    stocksStale: null,
    downloadFailed: null,
    generatedAt: null,
    l2,
  };
}

export async function GET(req: NextRequest) {
  const market = req.nextUrl.searchParams.get('market') as 'TW' | 'CN' | null;
  const detail = req.nextUrl.searchParams.get('detail') === '1';

  try {
    if (market === 'TW' || market === 'CN') {
      const health = await getMarketHealth(market, detail);
      return apiOk(health);
    }

    // 不指定市場：返回兩個市場
    const [tw, cn] = await Promise.all([
      getMarketHealth('TW', detail),
      getMarketHealth('CN', detail),
    ]);

    return apiOk({ markets: [tw, cn] });
  } catch (err) {
    return apiError(String(err));
  }
}
