/**
 * MarketDataIngestor — 掃描前資料覆蓋率檢查 + 缺失補下載
 *
 * 核心職責：
 *  1. 掃描前批量檢查本地資料覆蓋率
 *  2. 若覆蓋率不足，批量下載缺失股票的 K 線（帶統一限流）
 *  3. 回傳 CoverageReport 供 UI 顯示資料狀態
 *
 * 設計原則：
 *  - 掃描引擎永不直接打 API（已移除 L3 fallback）
 *  - 資料下載只在這裡和 cron 裡發生
 *  - 所有 API 呼叫經過 UnifiedRateLimiter
 */

import { batchCheckFreshness, saveLocalCandles } from './LocalCandleStore';
import { rateLimiter } from './UnifiedRateLimiter';
import type { MarketId } from '@/lib/scanner/types';

export interface CoverageReport {
  totalStocks: number;
  freshCount: number;
  staleCount: number;
  missingCount: number;
  coverageRate: number;        // 0-100%
  dataStatus: 'complete' | 'partial' | 'insufficient';
  /** 掃描前補缺結果（若有執行） */
  ingest?: {
    attempted: number;
    downloaded: number;
    failed: number;
    skipped: number;
  };
}

interface IngestOptions {
  /** 覆蓋率低於此值時觸發補缺下載（0-100，預設 90） */
  minCoverageForIngest?: number;
  /** 最多補缺幾檔（避免超時），預設 200 */
  maxIngestCount?: number;
  /** 下載用的 fetchCandles 函數（由 Scanner 提供） */
  fetchCandles: (symbol: string, asOfDate?: string) => Promise<import('@/types').CandleWithIndicators[]>;
  /** 下載並發數，預設 6 */
  concurrency?: number;
  /** 批次間延遲 ms，預設 500 */
  batchDelayMs?: number;
  /** 超時 ms，預設 120000 (2 分鐘) */
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * 檢查覆蓋率，必要時補缺下載
 */
export async function ensureCoverage(
  symbols: string[],
  market: MarketId,
  asOfDate: string | undefined,
  options: IngestOptions,
): Promise<CoverageReport> {
  const today = new Date().toISOString().split('T')[0];
  const targetDate = asOfDate ?? today;
  // 歷史掃描容忍度更高（5天），今日掃描 3 天
  const tolerance = (asOfDate && asOfDate < today) ? 5 : 3;

  // Step 1: 批量檢查本地資料新鮮度
  const { fresh, stale, missing } = await batchCheckFreshness(
    symbols, market, targetDate, tolerance,
  );

  const freshCount = fresh.length;
  const staleCount = stale.length;
  const missingCount = missing.length;
  const usableCount = freshCount + staleCount; // stale 在容忍範圍內仍可用
  const coverageRate = symbols.length > 0
    ? Math.round(usableCount / symbols.length * 100)
    : 100;

  const dataStatus: CoverageReport['dataStatus'] =
    coverageRate >= 95 ? 'complete' :
    coverageRate >= 70 ? 'partial' : 'insufficient';

  const report: CoverageReport = {
    totalStocks: symbols.length,
    freshCount,
    staleCount,
    missingCount,
    coverageRate,
    dataStatus,
  };

  // Step 2: 若覆蓋率不足且有 missing，嘗試補缺下載
  const minCoverage = options.minCoverageForIngest ?? 90;
  if (coverageRate < minCoverage && missing.length > 0) {
    const maxIngest = options.maxIngestCount ?? 200;
    const toDownload = missing.slice(0, maxIngest);
    const concurrency = options.concurrency ?? 6;
    const batchDelay = options.batchDelayMs ?? 500;
    const timeout = options.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeout;

    let downloaded = 0;
    let failed = 0;
    let skipped = 0;

    const providerName = market === 'TW' ? 'finmind' : 'eastmoney';

    for (let i = 0; i < toDownload.length; i += concurrency) {
      if (Date.now() > deadline) {
        skipped += toDownload.length - i;
        break;
      }

      const batch = toDownload.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        batch.map(async (symbol) => {
          await rateLimiter.acquire(providerName);

          try {
            const candles = await options.fetchCandles(symbol, asOfDate);
            if (candles.length > 0) {
              await saveLocalCandles(symbol, market, candles);
              rateLimiter.reportSuccess(providerName);
              return true;
            }
            return false;
          } catch (err) {
            const status = err instanceof Error && err.message.includes('402') ? 402
              : err instanceof Error && err.message.includes('429') ? 429 : 500;
            rateLimiter.reportError(providerName, status, err instanceof Error ? err.message : String(err));
            return false;
          }
        }),
      );

      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) downloaded++;
        else failed++;
      }

      if (i + concurrency < toDownload.length) await sleep(batchDelay);
    }

    report.ingest = {
      attempted: toDownload.length,
      downloaded,
      failed,
      skipped,
    };

    // 更新覆蓋率
    const newUsable = usableCount + downloaded;
    report.coverageRate = symbols.length > 0
      ? Math.round(newUsable / symbols.length * 100)
      : 100;
    report.freshCount += downloaded;
    report.missingCount -= downloaded;
    report.dataStatus =
      report.coverageRate >= 95 ? 'complete' :
      report.coverageRate >= 70 ? 'partial' : 'insufficient';
  }

  return report;
}
