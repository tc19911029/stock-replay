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
import { saveDownloadManifest } from '@/lib/datasource/DownloadManifest';
import { verifyDownload } from '@/lib/datasource/DownloadVerifier';
import { spotCheckL1 } from '@/lib/datasource/L1SpotCheck';
import {
  loadBackfillQueue,
  saveBackfillQueue,
  markAttempt,
  removeFromQueue,
  MAX_ATTEMPTS,
} from '@/lib/datasource/BackfillQueue';
import { dataProvider } from '@/lib/datasource/MultiMarketProvider';

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

    // ── Step -1: 消費 Backfill Queue（上輪 verify 發現缺棒的股票，針對性補拉） ──
    // 在主下載之前跑，因為補拉也會觸發 writeCandleFile merge，讓主下載看到已補齊狀態。
    // 預算：此步驟 30 秒內結束，超過就剩餘留到下一輪。
    const backfillStart = Date.now();
    const BACKFILL_BUDGET_MS = 30_000;
    let backfillFilled = 0;
    let backfillFailed = 0;
    let backfillSkipped = 0;
    try {
      const queue = await loadBackfillQueue(market);
      const actionable = queue.items.filter((it) => it.attempts < MAX_ATTEMPTS);
      if (actionable.length > 0) {
        console.info(`[download-candles] ${market}: backfill queue = ${actionable.length} actionable items`);
      }
      for (const item of actionable) {
        if (Date.now() - backfillStart > BACKFILL_BUDGET_MS) {
          backfillSkipped = actionable.length - (backfillFilled + backfillFailed);
          console.warn(`[download-candles] ${market}: backfill budget exhausted, ${backfillSkipped} items remain`);
          break;
        }
        try {
          // 展開所有 range，一次跨所有 gap 抓（上游 provider 都支援 range）
          const earliest = item.ranges.reduce((m, r) => r.from < m ? r.from : m, item.ranges[0].from);
          const latest = item.ranges.reduce((m, r) => r.to > m ? r.to : m, item.ranges[0].to);
          const filled = await dataProvider.getCandlesRange(item.symbol, earliest, latest);
          if (filled.length > 0) {
            await saveLocalCandles(item.symbol, market, filled);
            // 成功補拉 → 立即從 queue 移除，避免主下載/verify 中間 crash 時下輪重跑
            removeFromQueue(queue, item.symbol);
            backfillFilled++;
          } else {
            markAttempt(queue, item.symbol, 'provider returned empty');
            backfillFailed++;
          }
        } catch (err) {
          markAttempt(queue, item.symbol, String(err instanceof Error ? err.message : err));
          backfillFailed++;
        }
      }
      // 寫回 attempts 計數（成功項會在下一輪 verify 因為 gap=0 被清）
      await saveBackfillQueue(queue);
      if (backfillFilled > 0 || backfillFailed > 0) {
        console.info(
          `[download-candles] ${market}: backfill 完成 — ${backfillFilled} 補齊, ${backfillFailed} 失敗, ${backfillSkipped} 跳過`,
        );
      }
    } catch (err) {
      console.warn('[download-candles] backfill consume failed:', err);
    }

    // ── Step 0: 預載 L2 快照（API 失敗時作為 fallback） ──
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
        console.info(`[download-candles] ${market}: L2 快照已載入 ${l2Map.size} 支作為 fallback`);
      }
    } catch { /* L2 不可用，純 API 模式 */ }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async ({ symbol }) => {
          // 移除增量檢查：每次都重新下載，確保假期後恢復的第一天能更新到落後的本地檔

          const candles = await scanner.fetchCandles(symbol);
          if (candles.length > 0) {
            await saveLocalCandles(symbol, market, candles);
            return candles.length;
          }

          // API 返回 0 筆 → L2 fallback：從快照補今日 K 棒
          if (l2Map) {
            const l2Quote = l2Map.get(symbol);
            if (l2Quote) {
              const existing = await readCandleFile(symbol, market);
              if (existing && existing.lastDate < lastTradingDate) {
                await saveLocalCandles(symbol, market, [
                  ...existing.candles,
                  { date: lastTradingDate, open: l2Quote.open, high: l2Quote.high, low: l2Quote.low, close: l2Quote.close, volume: l2Quote.volume },
                ]);
                l2Injected++;
                return 1; // 算成功
              }
            }
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
      backfill: {
        filled: backfillFilled,
        failed: backfillFailed,
        skipped: backfillSkipped,
      },
      spotCheck: spotCheck ? { passed: spotCheck.passed, failed: spotCheck.failed, suspicious: spotCheck.suspicious } : undefined,
    });
  } catch (err) {
    console.error(`[download-candles] ${market}: 錯誤`, err);
    return apiError(String(err));
  }
}
