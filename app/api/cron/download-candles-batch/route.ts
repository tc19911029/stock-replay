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
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { suspectsLimitOverwrite } from '@/lib/datasource/limitMoveGuard';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { readIntradaySnapshot, IntradayQuote } from '@/lib/datasource/IntradayCache';
import { saveDownloadManifest } from '@/lib/datasource/DownloadManifest';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { verifyDownload } from '@/lib/datasource/DownloadVerifier';
import { spotCheckL1 } from '@/lib/datasource/L1SpotCheck';
import { detectCandleGaps } from '@/lib/datasource/validateCandles';

export const runtime = 'nodejs';
export const maxDuration = 300;

const CONCURRENCY = 8;
const BATCH_DELAY_MS = 300;
// 280s deadline（Vercel maxDuration=300s，留 20s 給 manifest/verify 收尾）
const SOFT_DEADLINE_MS = 280_000;
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

    // L1 被視為「近期」的門檻：7 日內 → L2 injection；更舊或缺失 → 全量 API 下載
    const recentThreshold = new Date(lastTradingDate);
    recentThreshold.setDate(recentThreshold.getDate() - 7);
    const recentThresholdStr = recentThreshold.toISOString().split('T')[0];

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
        console.info(`[download-batch] ${market} batch ${batch}: L2 快照已載入 ${l2Map.size} 支`);
      }
    } catch { /* L2 不可用，改走 API 模式 */ }

    console.info(`[download-batch] ${market} batch ${batch}/${totalBatches}: ${myStocks.length} 檔，L2=${l2Map?.size ?? 0}`);

    let earlyExit = false;
    let processedCount = 0;
    for (let i = 0; i < myStocks.length; i += CONCURRENCY) {
      // 軟 deadline：時間用完就 graceful exit，已下載部分會 commit
      if (Date.now() - startTime > SOFT_DEADLINE_MS) {
        console.warn(`[download-batch] ${market} batch ${batch}: 達到 soft deadline，已處理 ${processedCount}/${myStocks.length}，提前結束`);
        earlyExit = true;
        break;
      }
      const group = myStocks.slice(i, i + CONCURRENCY);
      processedCount = Math.min(i + CONCURRENCY, myStocks.length);
      const settled = await Promise.allSettled(
        group.map(async ({ symbol }) => {
          const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
          const existing = await readCandleFile(symbol, market);

          // 已是最新，跳過
          if (existing && existing.lastDate >= lastTradingDate) return -1;

          // L1 近期存在 + L2 有今日資料 → 直接 inject，不耗 API 配額
          // 但先偵測內部 gap：有洞的股票不走 fast-path，強制全量下載修補
          if (existing && existing.lastDate >= recentThresholdStr && l2Map) {
            const internalGaps = detectCandleGaps(existing.candles, 10, market);
            if (internalGaps.length > 0) {
              // 有內部 gap → 落入全量下載分支
              console.warn(`[download-batch] ${symbol} 有 ${internalGaps.length} 個 gap，強制全量下載`);
            } else {
              const l2Quote = l2Map.get(code);
              if (l2Quote) {
                const prevBar = existing.candles[existing.candles.length - 1];
                if (suspectsLimitOverwrite(prevBar?.close, l2Quote, market, code)) {
                  console.warn(
                    `[download-batch] ${symbol} ${lastTradingDate} L2 漲跌停 close 異常，` +
                    `跳過 L2 注入改走完整 API (prev=${prevBar.close} h=${l2Quote.high} c=${l2Quote.close})`
                  );
                } else {
                  await saveLocalCandles(symbol, market, [
                    { date: lastTradingDate, open: l2Quote.open, high: l2Quote.high, low: l2Quote.low, close: l2Quote.close, volume: l2Quote.volume },
                  ]);
                  l2Injected++;
                  return 1;
                }
              }
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

      if (i + CONCURRENCY < myStocks.length) await sleep(BATCH_DELAY_MS);

      if ((i + CONCURRENCY) % 100 < CONCURRENCY) {
        console.info(`[download-batch] ${market} batch ${batch}: ${i + CONCURRENCY}/${myStocks.length} (ok=${succeeded}, skip=${skipped}, fail=${failed})`);
      }
    }

    // ── 大盤代理 ETF + 主動式 ETF 下載（只在 batch 1 執行，避免重複）──────────────
    if (batch === 1) {
      const ACTIVE_ETF_SYMBOLS = [
        '00980A.TW', '00981A.TW', '00982A.TW', '00984A.TW', '00985A.TW',
        '00987A.TW', '00991A.TW', '00992A.TW', '00993A.TW', '00994A.TW', '00995A.TW',
      ];
      const proxySymbols = market === 'TW'
        ? ['0050.TW', ...ACTIVE_ETF_SYMBOLS]
        : ['000300.SS'];
      for (const proxy of proxySymbols) {
        try {
          const proxyExisting = await readCandleFile(proxy, market);
          if (!proxyExisting || proxyExisting.lastDate < lastTradingDate) {
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
    const completionLabel = earlyExit ? '部分完成（soft deadline）' : '完成';
    console.info(`[download-batch] ${market} batch ${batch}: ${completionLabel} — ${succeeded} 下載, ${l2Injected} L2注入, ${skipped} 跳過, ${failed} 失敗, ${duration}s`);

    // 保存批次清單
    await saveDownloadManifest(market, `${lastTradingDate}-batch${batch}`, {
      total: myStocks.length,
      succeeded,
      skipped,
      failed,
      coverage: Math.round((succeeded + skipped) / myStocks.length * 100),
      durationSec: parseFloat(duration),
    }).catch(err => console.warn('[download-batch] manifest save failed:', err));

    // ── 最後一批完成後生成 MA Base（供盤中粗掃即時 MA 計算用）──
    // earlyExit 時跳過所有 finalization，避免再爆 timeout（下次 cron 補做）
    let maBaseResult = { total: 0, succeeded: 0, failed: 0 };
    if (batch === totalBatches && !earlyExit) {
      try {
        const { generateMABase } = await import('@/lib/datasource/MABaseGenerator');
        // 用全部股票清單（不只是這一批）
        maBaseResult = await generateMABase(market, lastTradingDate, sorted);
        console.info(`[download-batch] ${market}: MA Base 已生成 (${maBaseResult.succeeded}/${maBaseResult.total})`);
      } catch (err) {
        console.warn('[download-batch] MA Base generation failed:', err);
      }
    }

    // ── 最後一批完成後跑校驗報告（聚合所有批次統計） ──
    let verifyResult: { health: string; coverageRate: number; stocksWithGaps: number; stocksStale: number } | undefined;
    if (batch === totalBatches && !earlyExit) {
      try {
        // 聚合所有批次的 manifest 統計
        const { loadDownloadManifest: loadManifest } = await import('@/lib/datasource/DownloadManifest');
        let totalSucceeded = succeeded;
        let totalFailed = failed;
        let totalSkipped = skipped;
        for (let b = 1; b < totalBatches; b++) {
          const prev = await loadManifest(market, `${lastTradingDate}-batch${b}`);
          if (prev) {
            totalSucceeded += prev.succeeded;
            totalFailed += prev.failed;
            totalSkipped += prev.skipped;
          }
        }
        const allSymbols = sorted.map(s => s.symbol);
        const report = await verifyDownload(market, lastTradingDate, allSymbols, {
          succeeded: totalSucceeded, failed: totalFailed, skipped: totalSkipped,
        });
        verifyResult = {
          health: report.health,
          coverageRate: report.summary.coverageRate,
          stocksWithGaps: report.summary.stocksWithGaps,
          stocksStale: report.summary.stocksStale,
        };
      } catch (err) {
        console.warn('[download-batch] verify failed:', err);
      }
    }

    // ── 最後一批完成後跑 L1 抽查（Yahoo 交叉核驗） ──
    let spotCheck: import('@/lib/datasource/L1SpotCheck').SpotCheckResult | undefined;
    if (batch === totalBatches && !earlyExit) {
      try {
        const allSymbols = sorted.map(s => s.symbol);
        spotCheck = await spotCheckL1(market, lastTradingDate, allSymbols);
      } catch (err) {
        console.warn('[download-batch] L1 抽查失敗:', err);
      }
    }

    return apiOk({
      market,
      batch,
      totalBatches,
      batchStocks: myStocks.length,
      processedCount,
      earlyExit,
      totalStocks: sorted.length,
      succeeded,
      l2Injected,
      skipped,
      failed,
      durationSec: parseFloat(duration),
      maBase: batch === totalBatches && !earlyExit ? maBaseResult : undefined,
      verify: verifyResult,
      spotCheck: spotCheck ? { passed: spotCheck.passed, failed: spotCheck.failed, suspicious: spotCheck.suspicious } : undefined,
    });
  } catch (err) {
    console.error(`[download-batch] ${market} batch ${batch}: 錯誤`, err);
    return apiError(String(err));
  }
}
