/**
 * 每日收盤後預下載全市場 K 線到本地
 *
 * 用法：
 *   GET /api/cron/download-candles?market=TW
 *   GET /api/cron/download-candles?market=CN
 *
 * Vercel cron schedule:
 *   台股 13:45 CST (UTC 05:45) — 收盤後 15 分鐘
 *   陸股 15:15 CST (UTC 07:15) — 收盤後 15 分鐘
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { saveDownloadManifest } from '@/lib/datasource/DownloadManifest';
import { verifyDownload } from '@/lib/datasource/DownloadVerifier';

export const runtime = 'nodejs';
export const maxDuration = 300;

const CONCURRENCY = 8;
const BATCH_DELAY_MS = 300;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function GET(req: NextRequest) {
  // 驗證 cron secret
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  const market = req.nextUrl.searchParams.get('market') as 'TW' | 'CN' | null;
  if (market !== 'TW' && market !== 'CN') {
    return apiError('market must be TW or CN', 400);
  }

  const startTime = Date.now();
  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();

  // 取得最近交易日（增量檢查用）
  const now = new Date();
  const dow = now.getDay();
  if (dow === 0) now.setDate(now.getDate() - 2);
  else if (dow === 6) now.setDate(now.getDate() - 1);
  const lastTradingDate = now.toISOString().split('T')[0];

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  try {
    const stocks = await scanner.getStockList();
    console.info(`[download-candles] ${market}: 開始下載 ${stocks.length} 檔 K 線（增量模式）`);

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async ({ symbol }) => {
          // 移除增量檢查：每次都重新下載，確保假期後恢復的第一天能更新到落後的本地檔
          // （原本 isLocalDataFresh 在 cron 停擺期間會錯誤地跳過落後的檔案）

          const candles = await scanner.fetchCandles(symbol);
          if (candles.length > 0) {
            await saveLocalCandles(symbol, market, candles);
          }
          return candles.length;
        })
      );

      for (const r of settled) {
        if (r.status === 'fulfilled') {
          if (r.value === -1) skipped++;
          else if (r.value > 0) succeeded++;
          else failed++;
        } else {
          failed++;
        }
      }

      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);

      // 進度 log（每 100 檔印一次）
      if ((i + CONCURRENCY) % 100 < CONCURRENCY) {
        console.info(`[download-candles] ${market}: ${i + CONCURRENCY}/${stocks.length} (ok=${succeeded}, skip=${skipped}, fail=${failed})`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.info(`[download-candles] ${market}: 完成 — ${succeeded} 下載, ${skipped} 跳過, ${failed} 失敗, ${duration}s`);

    // 保存下載清單（供掃描前檢查覆蓋率使用）
    await saveDownloadManifest(market, lastTradingDate, {
      total: stocks.length,
      succeeded,
      skipped,
      failed,
      coverage: Math.round((succeeded + skipped) / stocks.length * 100),
      durationSec: parseFloat(duration),
    }).catch(err => console.warn('[download-candles] manifest save failed:', err));

    // ── 生成 MA Base（供盤中粗掃即時 MA 計算用）──
    let maBaseResult = { total: 0, succeeded: 0, failed: 0 };
    try {
      const { generateMABase } = await import('@/lib/datasource/MABaseGenerator');
      maBaseResult = await generateMABase(market, lastTradingDate, stocks);
      console.info(`[download-candles] ${market}: MA Base 已生成 (${maBaseResult.succeeded}/${maBaseResult.total})`);
    } catch (err) {
      console.warn('[download-candles] MA Base generation failed:', err);
    }

    // ── 校驗下載結果（gap + lastDate + 覆蓋率報告）──
    let verifyResult: { health: string; coverageRate: number; stocksWithGaps: number; stocksStale: number } | undefined;
    try {
      const allSymbols = stocks.map(s => s.symbol);
      const report = await verifyDownload(market, lastTradingDate, allSymbols, { succeeded, failed, skipped });
      verifyResult = {
        health: report.health,
        coverageRate: report.summary.coverageRate,
        stocksWithGaps: report.summary.stocksWithGaps,
        stocksStale: report.summary.stocksStale,
      };
    } catch (err) {
      console.warn('[download-candles] verify failed:', err);
    }

    return apiOk({
      market,
      totalStocks: stocks.length,
      succeeded,
      skipped,
      failed,
      durationSec: parseFloat(duration),
      maBase: maBaseResult,
      verify: verifyResult,
    });
  } catch (err) {
    console.error(`[download-candles] ${market}: 錯誤`, err);
    return apiError(String(err));
  }
}
