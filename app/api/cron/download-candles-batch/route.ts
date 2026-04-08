/**
 * 分批下載全市場 K 線（解決 Vercel 300s timeout 限制）
 *
 * 用法：
 *   GET /api/cron/download-candles-batch?market=CN&batch=1&totalBatches=4
 *
 * 將全部股票按 symbol 排序後均分成 N 批，每個 cron job 只處理自己那一批。
 * 支援增量下載：跳過本地已有今日數據的股票。
 *
 * Vercel cron schedule（間隔 6 分鐘避免同時打 API）：
 *   batch 1: 07:15 UTC  batch 2: 07:21 UTC
 *   batch 3: 07:27 UTC  batch 4: 07:33 UTC
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { saveLocalCandles, isLocalDataFresh } from '@/lib/datasource/LocalCandleStore';
import { saveDownloadManifest } from '@/lib/datasource/DownloadManifest';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';
export const maxDuration = 300;

const CONCURRENCY = 8;
const BATCH_DELAY_MS = 300;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  const market = req.nextUrl.searchParams.get('market') as 'TW' | 'CN' | null;
  if (market !== 'TW' && market !== 'CN') {
    return apiError('market must be TW or CN', 400);
  }

  const batch = parseInt(req.nextUrl.searchParams.get('batch') ?? '1', 10);
  const totalBatches = parseInt(req.nextUrl.searchParams.get('totalBatches') ?? '4', 10);
  if (batch < 1 || batch > totalBatches || totalBatches < 1 || totalBatches > 10) {
    return apiError('invalid batch/totalBatches', 400);
  }

  const startTime = Date.now();
  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
  const lastTradingDate = getLastTradingDay(market);

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  try {
    const allStocks = await scanner.getStockList();
    // 確定性排序後分片
    const sorted = [...allStocks].sort((a, b) => a.symbol.localeCompare(b.symbol));
    const chunkSize = Math.ceil(sorted.length / totalBatches);
    const myStocks = sorted.slice((batch - 1) * chunkSize, batch * chunkSize);

    console.info(`[download-batch] ${market} batch ${batch}/${totalBatches}: ${myStocks.length} 檔（全部 ${sorted.length}）`);

    for (let i = 0; i < myStocks.length; i += CONCURRENCY) {
      const group = myStocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        group.map(async ({ symbol }) => {
          // 增量檢查：本地數據已是最新的就跳過
          const fresh = await isLocalDataFresh(symbol, market, lastTradingDate);
          if (fresh) return -1; // skip marker

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

      if (i + CONCURRENCY < myStocks.length) await sleep(BATCH_DELAY_MS);

      if ((i + CONCURRENCY) % 100 < CONCURRENCY) {
        console.info(`[download-batch] ${market} batch ${batch}: ${i + CONCURRENCY}/${myStocks.length} (ok=${succeeded}, skip=${skipped}, fail=${failed})`);
      }
    }

    // ── 大盤代理 ETF 下載（只在 batch 1 執行，避免重複）──────────────
    if (batch === 1) {
      const proxySymbols = market === 'TW' ? ['0050.TW'] : ['000300.SS'];
      for (const proxy of proxySymbols) {
        try {
          const fresh = await isLocalDataFresh(proxy, market, lastTradingDate);
          if (!fresh) {
            const candles = await scanner.fetchCandles(proxy);
            if (candles.length > 0) {
              await saveLocalCandles(proxy, market, candles);
              console.info(`[download-batch] ${market} proxy ${proxy}: ${candles.length} candles saved`);
            }
          }
        } catch (err) {
          console.warn(`[download-batch] ${market} proxy ${proxy} failed:`, err);
        }
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.info(`[download-batch] ${market} batch ${batch}: 完成 — ${succeeded} 下載, ${skipped} 跳過, ${failed} 失敗, ${duration}s`);

    // 保存批次清單
    await saveDownloadManifest(market, `${lastTradingDate}-batch${batch}`, {
      total: myStocks.length,
      succeeded,
      skipped,
      failed,
      coverage: Math.round((succeeded + skipped) / myStocks.length * 100),
      durationSec: parseFloat(duration),
    }).catch(err => console.warn('[download-batch] manifest save failed:', err));

    return apiOk({
      market,
      batch,
      totalBatches,
      batchStocks: myStocks.length,
      totalStocks: sorted.length,
      succeeded,
      skipped,
      failed,
      durationSec: parseFloat(duration),
    });
  } catch (err) {
    console.error(`[download-batch] ${market} batch ${batch}: 錯誤`, err);
    return apiError(String(err));
  }
}
