import { NextRequest } from 'next/server';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { ScanSession } from '@/lib/scanner/types';
import { saveScanSession } from '@/lib/storage/scanStorage';
import { scanDabanFromLocalCandles } from '@/lib/scanner/DabanScanner';
import { saveDabanSession } from '@/lib/storage/dabanStorage';
import { apiOk, apiError } from '@/lib/api/response';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import { isWeekday } from '@/lib/utils/tradingDay';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  try {
    const scanner = new ChinaScanner();
    const { getLastTradingDay } = await import('@/lib/datasource/marketHours');
    const date = getLastTradingDay('CN');

    if (!isWeekday(date, 'CN')) {
      return apiOk({ skipped: true, reason: 'non-trading day (weekend)', date });
    }

    const stocks = await scanner.getStockList();
    const counts: Record<string, number> = {};

    // ── Long scan (daily — no MTF filter) ──
    const { results, marketTrend, sessionFreshness } = await scanner.scanSOP(stocks, date);
    const longDailySession: ScanSession = {
      id: `CN-long-daily-${date}-${Date.now()}`,
      market: 'CN', date, direction: 'long',
      multiTimeframeEnabled: false,
      scanTime: new Date().toISOString(),
      resultCount: results.length, results,
      dataFreshness: sessionFreshness,
    };
    try { await saveScanSession(longDailySession); } catch { /* non-fatal */ }
    counts.longDaily = results.length;

    // ── Long scan (MTF) ──
    try {
      const { results: mtfResults, sessionFreshness: mtfFreshness } = await scanner.scanSOP(stocks, date, { ...ZHU_V1.thresholds, multiTimeframeFilter: true });
      const longMtfSession: ScanSession = {
        id: `CN-long-mtf-${date}-${Date.now()}`,
        market: 'CN', date, direction: 'long',
        multiTimeframeEnabled: true,
        scanTime: new Date().toISOString(),
        resultCount: mtfResults.length, results: mtfResults,
        dataFreshness: mtfFreshness,
      };
      await saveScanSession(longMtfSession);
      counts.longMtf = mtfResults.length;
    } catch { counts.longMtf = 0; }

    // ── Short scan (daily) ──
    try {
      const { candidates: shortResults, sessionFreshness: shortFreshness } = await scanner.scanShortCandidates(stocks, date);
      const shortDailySession: ScanSession = {
        id: `CN-short-daily-${date}-${Date.now()}`,
        market: 'CN', date, direction: 'short',
        multiTimeframeEnabled: false,
        scanTime: new Date().toISOString(),
        resultCount: shortResults.length, results: shortResults,
        dataFreshness: shortFreshness,
      };
      await saveScanSession(shortDailySession);
      counts.shortDaily = shortResults.length;
    } catch { counts.shortDaily = 0; }

    // ── Short scan (MTF) ──
    try {
      const { candidates: shortMtfResults, sessionFreshness: shortMtfFreshness } = await scanner.scanShortCandidates(stocks, date, { ...ZHU_V1.thresholds, multiTimeframeFilter: true });
      const shortMtfSession: ScanSession = {
        id: `CN-short-mtf-${date}-${Date.now()}`,
        market: 'CN', date, direction: 'short',
        multiTimeframeEnabled: true,
        scanTime: new Date().toISOString(),
        resultCount: shortMtfResults.length, results: shortMtfResults,
        dataFreshness: shortMtfFreshness,
      };
      await saveScanSession(shortMtfSession);
      counts.shortMtf = shortMtfResults.length;
    } catch { counts.shortMtf = 0; }

    // ── 打板掃描 ──
    // 安全檢查：漲停股通常 20-100 支/天。如果掃出 < 5 支
    // 可能是 K 線不完整（Blob 資料過舊），不儲存以免污染歷史資料。
    try {
      const dabanSession = await scanDabanFromLocalCandles(date);
      if (dabanSession.resultCount >= 5) {
        await saveDabanSession(dabanSession);
        counts.daban = dabanSession.resultCount;
      } else {
        console.warn(`[cron/scan-cn] 打板掃描僅找到 ${dabanSession.resultCount} 檔，疑似資料不完整，不儲存`);
        counts.daban = -1; // 標記為資料不完整
      }
    } catch { counts.daban = 0; }

    const notifyEmail = process.env.NOTIFY_EMAIL;
    const resendKey = process.env.RESEND_API_KEY;
    if (notifyEmail && resendKey && results.length > 0) {
      try {
        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
        await fetch(`${siteUrl}/api/notify/email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: notifyEmail, results, market: 'CN' }),
        });
      } catch { /* notification failure is non-fatal */ }
    }

    return apiOk({ counts, date, marketTrend });
  } catch (err) {
    return apiError(String(err));
  }
}
