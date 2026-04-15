import { NextRequest } from 'next/server';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { ScanSession } from '@/lib/scanner/types';
import { saveScanSession } from '@/lib/storage/scanStorage';
import { apiOk, apiError } from '@/lib/api/response';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { loadVerifyReport } from '@/lib/datasource/DownloadVerifier';

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
    // 支援手動補掃：?date=YYYY-MM-DD
    const dateParam = req.nextUrl.searchParams.get('date');
    const date = dateParam ?? getLastTradingDay('CN');

    if (!isTradingDay(date, 'CN')) {
      return apiOk({ skipped: true, reason: 'non-trading day', date });
    }

    // ── L1 新鮮度前置檢查 ──
    const verifyReport = await loadVerifyReport('CN', date);
    if (verifyReport && verifyReport.summary.coverageRate < 0.9) {
      console.warn(
        `[cron/scan-cn] L1 覆蓋率不足 ${(verifyReport.summary.coverageRate * 100).toFixed(1)}%，` +
        `掃描結果可能不完整`
      );
    }

    const stocks = await scanner.getStockList();
    const counts: Record<string, number> = {};

    // ── L2 即時報價注入（確保今日K棒可用，即使 L1 尚未下載）──
    try {
      const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
      const snap = await readIntradaySnapshot('CN', date);
      if (snap && snap.quotes.length > 0) {
        const realtimeQuotes = new Map<string, { open: number; high: number; low: number; close: number; volume: number; date?: string }>();
        for (const q of snap.quotes) {
          const code = q.symbol.replace(/\.(SS|SZ)$/i, '');
          if (q.close > 0) {
            realtimeQuotes.set(code, {
              open: q.open, high: q.high, low: q.low,
              close: q.close, volume: q.volume, date: snap.date,
            });
          }
        }
        if (realtimeQuotes.size > 0) {
          scanner.setRealtimeQuotes(realtimeQuotes);
          console.log(`[cron/scan-cn] 注入 L2 報價: ${realtimeQuotes.size} 支 (${snap.date})`);
        }
      }
    } catch {
      console.warn('[cron/scan-cn] L2 注入失敗，掃描將使用 L1 數據');
    }

    // ── Long scan (daily — no MTF filter) ──
    const { results, marketTrend, sessionFreshness } = await scanner.scanSOP(stocks, date);
    const longDailySession: ScanSession = {
      id: `CN-long-daily-${date}-${Date.now()}`,
      market: 'CN', date, direction: 'long',
      multiTimeframeEnabled: false,
      sessionType: 'post_close',
      scanTime: new Date().toISOString(),
      resultCount: results.length, results,
      dataFreshness: sessionFreshness,
    };
    try { await saveScanSession(longDailySession, { allowOverwritePostClose: true }); } catch { /* non-fatal */ }
    counts.longDaily = results.length;

    // ── Long scan (MTF) ──
    try {
      const { results: mtfResults, sessionFreshness: mtfFreshness } = await scanner.scanSOP(stocks, date, { ...ZHU_V1.thresholds, multiTimeframeFilter: true });
      const longMtfSession: ScanSession = {
        id: `CN-long-mtf-${date}-${Date.now()}`,
        market: 'CN', date, direction: 'long',
        multiTimeframeEnabled: true,
        sessionType: 'post_close',
        scanTime: new Date().toISOString(),
        resultCount: mtfResults.length, results: mtfResults,
        dataFreshness: mtfFreshness,
      };
      await saveScanSession(longMtfSession, { allowOverwritePostClose: true });
      counts.longMtf = mtfResults.length;
    } catch { counts.longMtf = 0; }

    // ── Short scan (daily) ──
    try {
      const { candidates: shortResults, sessionFreshness: shortFreshness } = await scanner.scanShortCandidates(stocks, date);
      const shortDailySession: ScanSession = {
        id: `CN-short-daily-${date}-${Date.now()}`,
        market: 'CN', date, direction: 'short',
        multiTimeframeEnabled: false,
        sessionType: 'post_close',
        scanTime: new Date().toISOString(),
        resultCount: shortResults.length, results: shortResults,
        dataFreshness: shortFreshness,
      };
      await saveScanSession(shortDailySession, { allowOverwritePostClose: true });
      counts.shortDaily = shortResults.length;
    } catch { counts.shortDaily = 0; }

    // ── Short scan (MTF) ──
    try {
      const { candidates: shortMtfResults, sessionFreshness: shortMtfFreshness } = await scanner.scanShortCandidates(stocks, date, { ...ZHU_V1.thresholds, multiTimeframeFilter: true });
      const shortMtfSession: ScanSession = {
        id: `CN-short-mtf-${date}-${Date.now()}`,
        market: 'CN', date, direction: 'short',
        multiTimeframeEnabled: true,
        sessionType: 'post_close',
        scanTime: new Date().toISOString(),
        resultCount: shortMtfResults.length, results: shortMtfResults,
        dataFreshness: shortMtfFreshness,
      };
      await saveScanSession(shortMtfSession, { allowOverwritePostClose: true });
      counts.shortMtf = shortMtfResults.length;
    } catch { counts.shortMtf = 0; }

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

    // ── 零結果告警 ──
    const alert = counts.longDaily === 0;
    if (alert) {
      console.warn(`[cron/scan-cn] ★ 交易日 ${date} long-daily 掃描結果 0 筆`);
    }

    return apiOk({
      counts, date, marketTrend,
      ...(alert && { alert: true, warning: `交易日 ${date} long-daily 0 筆` }),
      ...(verifyReport && { l1CoverageRate: verifyReport.summary.coverageRate }),
    });
  } catch (err) {
    return apiError(String(err));
  }
}
