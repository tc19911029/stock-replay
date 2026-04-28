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
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { readIntradaySnapshot, IntradayQuote } from '@/lib/datasource/IntradayCache';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { saveDownloadManifest } from '@/lib/datasource/DownloadManifest';
import { verifyDownload } from '@/lib/datasource/DownloadVerifier';
import { spotCheckL1 } from '@/lib/datasource/L1SpotCheck';

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

  const lastTradingDate = getLastTradingDay(market);

  // L1 被視為「近期」的門檻：7 日內 → L2 injection；更舊或缺失 → 全量 API 下載
  const recentThreshold = new Date(lastTradingDate);
  recentThreshold.setDate(recentThreshold.getDate() - 7);
  const recentThresholdStr = recentThreshold.toISOString().split('T')[0];

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  try {
    const stocks = await scanner.getStockList();

    // ── 預載 L2 快照（主路徑） ──
    let l2Map: Map<string, IntradayQuote> | null = null;
    let l2Injected = 0;
    try {
      const snap = await readIntradaySnapshot(market, lastTradingDate);
      if (snap && snap.quotes.length > 0 && snap.date === lastTradingDate) {
        l2Map = new Map();
        for (const q of snap.quotes) {
          if (q.close > 0) {
            const code = q.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
            l2Map.set(code, q);
          }
        }
        console.info(`[download-candles] ${market}: L2 快照已載入 ${l2Map.size} 支`);
      }
    } catch { /* L2 不可用，改走 API 模式 */ }

    console.info(`[download-candles] ${market}: ${stocks.length} 支，L2=${l2Map?.size ?? 0}，模式=${l2Map ? 'L2主路徑+API補缺' : '純API'}`);

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async ({ symbol }) => {
          const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
          const existing = await readCandleFile(symbol, market);

          // 已是最新，跳過
          if (existing && existing.lastDate >= lastTradingDate) return -1;

          // L1 近期存在 + L2 有今日資料 → 直接 inject，不耗 API 配額
          // writeCandleFile 內部自行讀取並 merge，只傳新增的一根即可
          if (existing && existing.lastDate >= recentThresholdStr && l2Map) {
            const l2Quote = l2Map.get(code);
            if (l2Quote) {
              await saveLocalCandles(symbol, market, [
                { date: lastTradingDate, open: l2Quote.open, high: l2Quote.high, low: l2Quote.low, close: l2Quote.close, volume: l2Quote.volume },
              ]);
              l2Injected++;
              return 1;
            }
          }

          // L1 缺失、太舊、或 L2 沒有此股 → 全量 API 下載
          const candles = await scanner.fetchCandles(symbol);
          if (candles.length > 0) {
            await saveLocalCandles(symbol, market, candles);
            return candles.length;
          }
          return 0;
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
    console.info(`[download-candles] ${market}: 完成 — ${succeeded} 下載, ${l2Injected} L2注入, ${skipped} 跳過, ${failed} 失敗, ${duration}s`);

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

    // ── L1 抽查（Yahoo 交叉核驗） ──
    let spotCheck: import('@/lib/datasource/L1SpotCheck').SpotCheckResult | undefined;
    try {
      const allSymbols = stocks.map(s => s.symbol);
      spotCheck = await spotCheckL1(market, lastTradingDate, allSymbols);
    } catch (err) {
      console.warn('[download-candles] L1 抽查失敗:', err);
    }

    return apiOk({
      market,
      totalStocks: stocks.length,
      succeeded,
      l2Injected,
      skipped,
      failed,
      durationSec: parseFloat(duration),
      maBase: maBaseResult,
      verify: verifyResult,
      spotCheck: spotCheck ? { passed: spotCheck.passed, failed: spotCheck.failed, suspicious: spotCheck.suspicious } : undefined,
    });
  } catch (err) {
    console.error(`[download-candles] ${market}: 錯誤`, err);
    return apiError(String(err));
  }
}
