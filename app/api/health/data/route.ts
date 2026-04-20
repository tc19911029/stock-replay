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
import {
  readIntradaySnapshot,
  getDataSourceStatus,
  getConsecutiveEmptyCount,
  getLastRefreshAttempt,
  type DataSourceStatus,
} from '@/lib/datasource/IntradayCache';
import { getLastTradingDay, isMarketOpen, isPostCloseWindow } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { listScanDates } from '@/lib/storage/scanStorage';

export const runtime = 'nodejs';

interface L2Status {
  /** fresh / stale / missing */
  status: 'fresh' | 'stale' | 'missing';
  /** 快照中的報價數量 */
  quoteCount: number | null;
  /** 快照年齡（秒） */
  ageSeconds: number | null;
  /** 快照更新時間（數據實際更新時間） */
  updatedAt: string | null;
  /** 最近一次嘗試刷新時間（不論成功或失敗，區分 cron 沒跑 vs API 掛了） */
  lastCheckedAt: string | null;
  /** lastCheckedAt 距今秒數 */
  lastCheckedAgeSeconds: number | null;
}

interface L2SourceInfo {
  /** 各數據源最近一次調用狀態 */
  sources: DataSourceStatus[];
  /** 連續空快照次數（交易日 API 全失敗） */
  consecutiveEmptyCount: number;
  /** 今天是否為交易日 */
  isTradingDay: boolean;
  /** 告警等級 */
  alertLevel: 'none' | 'warning' | 'critical';
}

interface L4Status {
  /** 最新掃描日期 */
  lastScanDate: string | null;
  /** 最新掃描結果數 */
  lastScanCount: number;
  /** 最新掃描時間 */
  lastScanTime: string | null;
  /** 有多少天有掃描紀錄（最多 20） */
  totalDatesAvailable: number;
  /** 今天是否有盤中掃描 */
  todayHasIntraday: boolean;
  /** 最新掃描距今秒數 */
  ageSeconds: number | null;
  /** fresh / stale / missing */
  status: 'fresh' | 'stale' | 'missing';
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
  /** L2 數據源詳細狀態 */
  l2Sources: L2SourceInfo;
  /** L4 掃描結果狀態 */
  l4: L4Status;
  /** 完整報告（可選，?detail=1 時返回） */
  report?: VerifyReport;
}

function getTodayDate(market: 'TW' | 'CN'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
  }).format(new Date());
}

async function getL2Status(market: 'TW' | 'CN'): Promise<L2Status> {
  // 週末/假日：看最近交易日的 L2（不是今天，今天不會有檔）
  const today = getTodayDate(market);
  const trading = isTradingDay(today, market);
  const lookupDate = trading ? today : getLastTradingDay(market);
  const snapshot = await readIntradaySnapshot(market, lookupDate);

  // 取得最近一次嘗試刷新時間（不論成功或失敗）
  const lastCheckedAt = getLastRefreshAttempt(market);
  const lastCheckedAgeSeconds = lastCheckedAt
    ? Math.round((Date.now() - new Date(lastCheckedAt).getTime()) / 1000)
    : null;

  if (!snapshot || snapshot.count === 0) {
    return { status: 'missing', quoteCount: null, ageSeconds: null, updatedAt: null, lastCheckedAt, lastCheckedAgeSeconds };
  }

  const ageMs = Date.now() - new Date(snapshot.updatedAt).getTime();
  const ageSeconds = Math.round(ageMs / 1000);

  // 盤後且有今天的快照 → 視為 fresh（那是當天收盤的最終數據）
  const marketOpen = isMarketOpen(market);
  const postCloseWin = isPostCloseWindow(market);
  if (!marketOpen && !postCloseWin && snapshot.count > 0) {
    return {
      status: 'fresh',
      quoteCount: snapshot.count,
      ageSeconds,
      updatedAt: snapshot.updatedAt,
      lastCheckedAt,
      lastCheckedAgeSeconds,
    };
  }

  // 盤中/盤後窗口：用時間判斷新鮮度
  // fresh: <5分鐘 | stale: 5-30分鐘 | missing: >30分鐘
  let status: L2Status['status'] = 'fresh';
  if (ageSeconds > 30 * 60) {
    status = 'missing';
  } else if (ageSeconds > 5 * 60) {
    status = 'stale';
  }

  // 有快照數據時，最差也是 stale（不該是 missing/無數據）
  if (status === 'missing' && snapshot.count > 0) {
    status = 'stale';
  }

  return {
    status,
    quoteCount: snapshot.count,
    ageSeconds,
    updatedAt: snapshot.updatedAt,
    lastCheckedAt,
    lastCheckedAgeSeconds,
  };
}

async function getL4Status(market: 'TW' | 'CN'): Promise<L4Status> {
  const today = getTodayDate(market);
  const marketOpen = isMarketOpen(market);
  const postClose = isPostCloseWindow(market);

  try {
    const entries = await listScanDates(market, 'long', 'daily');
    const totalDatesAvailable = entries.length;
    const latest = entries[0] ?? null;
    const todayHasIntraday = entries.some(e => e.date === today);

    if (!latest) {
      return {
        lastScanDate: null, lastScanCount: 0, lastScanTime: null,
        totalDatesAvailable: 0, todayHasIntraday: false,
        ageSeconds: null, status: 'missing',
      };
    }

    const ageSeconds = latest.scanTime
      ? Math.round((Date.now() - new Date(latest.scanTime).getTime()) / 1000)
      : null;

    // 新鮮度判斷
    let status: L4Status['status'] = 'missing';
    if (!marketOpen && !postClose && latest.date === today) {
      // 盤後但有今天的掃描 → fresh（收盤數據）
      status = 'fresh';
    } else if (!marketOpen && !postClose && latest.date !== today) {
      // 盤後但最新不是今天 → 看是否為最近交易日
      const lastTrading = getLastTradingDay(market);
      status = latest.date >= lastTrading ? 'fresh' : 'stale';
    } else if (ageSeconds != null) {
      // 盤中：<10 分鐘 = fresh, 10-30 分鐘 = stale, >30 分鐘 = missing
      if (ageSeconds < 10 * 60) status = 'fresh';
      else if (ageSeconds < 30 * 60) status = 'stale';
      else status = 'missing';
    }

    // 有今天的掃描結果時，最差也是 stale（不該是 missing/無數據）
    // 例如：CN post_close 在盤前 06:53 跑過且有 4 筆結果，盤中 age > 30 min 但數據仍有效
    if (status === 'missing' && latest.date === today && latest.resultCount > 0) {
      status = 'stale';
    }

    return {
      lastScanDate: latest.date,
      lastScanCount: latest.resultCount,
      lastScanTime: latest.scanTime ?? null,
      totalDatesAvailable,
      todayHasIntraday,
      ageSeconds,
      status,
    };
  } catch (err) {
    console.error('[health/data] getL4Status error:', err);
    return {
      lastScanDate: null, lastScanCount: 0, lastScanTime: null,
      totalDatesAvailable: 0, todayHasIntraday: false,
      ageSeconds: null, status: 'missing',
    };
  }
}

async function getMarketHealth(
  market: 'TW' | 'CN',
  includeDetail: boolean,
): Promise<MarketHealth> {
  const lastTrading = getLastTradingDay(market);

  // L2 + L4 並行讀取
  const l2Promise = getL2Status(market);
  const l4Promise = getL4Status(market);

  // 嘗試讀取最近 7 天的報告（可能假日/週末沒報告 — 週一要能回看到上週五）
  let l1Result: Omit<MarketHealth, 'l2' | 'l2Sources' | 'l4'> | null = null;
  for (let daysBack = 0; daysBack < 7; daysBack++) {
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

  const [l2, l4] = await Promise.all([l2Promise, l4Promise]);

  // L2 數據源狀態
  const today = getTodayDate(market);
  const emptyCount = getConsecutiveEmptyCount(market);
  const trading = isTradingDay(today, market);
  let alertLevel: L2SourceInfo['alertLevel'] = 'none';
  if (trading && emptyCount >= 3) alertLevel = 'critical';
  else if (trading && emptyCount >= 1) alertLevel = 'warning';

  const l2Sources: L2SourceInfo = {
    sources: getDataSourceStatus(market),
    consecutiveEmptyCount: emptyCount,
    isTradingDay: trading,
    alertLevel,
  };

  if (l1Result) {
    return { ...l1Result, l2, l2Sources, l4 };
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
    l2Sources,
    l4,
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
