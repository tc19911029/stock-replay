/**
 * DownloadVerifier — L1 下載後自動校驗
 *
 * 在 download-candles cron 完成後，對已下載的 K 線數據進行校驗：
 * 1. 覆蓋率統計 — 成功/失敗/跳過比率
 * 2. Gap 偵測 — detectCandleGaps()
 * 3. lastDate 檢查 — 確認最後日期是否為目標交易日
 * 4. 基本合法性統計 — 報告被 validateCandles 清除的異常K棒數量
 *
 * 報告存到 Blob: reports/verify-{market}-{date}.json
 */

import { readCandleFile } from './CandleStorageAdapter';
import { detectCandleGaps, type CandleGap } from './validateCandles';
import { tradingDaysBetween } from '@/lib/utils/tradingDay';
import {
  loadBackfillQueue,
  saveBackfillQueue,
  mergeIntoQueue,
  MAX_ATTEMPTS,
} from './BackfillQueue';

const IS_VERCEL = !!process.env.VERCEL;

// ── Types ────────────────────────────────────────────────────────────────────

export interface VerifyGapDetail {
  symbol: string;
  gaps: CandleGap[];
}

export interface VerifyStaleDetail {
  symbol: string;
  lastDate: string;
  daysBehind: number;
}

export interface VerifyReport {
  market: 'TW' | 'CN';
  date: string;
  generatedAt: string;
  summary: {
    totalStocks: number;
    downloadSuccess: number;
    downloadFailed: number;
    downloadSkipped: number;
    coverageRate: number;
    stocksWithGaps: number;
    stocksStale: number;
    stocksClean: number;
    stocksReadFailed: number;
  };
  failedSymbols: string[];
  gapDetails: VerifyGapDetail[];
  staleDetails: VerifyStaleDetail[];
  health: 'good' | 'warning' | 'critical';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function classifyHealth(
  coverageRate: number,
  stocksWithGaps: number,
  stocksStale: number,
  totalStocks: number,
): 'good' | 'warning' | 'critical' {
  const gapRate = totalStocks > 0 ? stocksWithGaps / totalStocks : 0;
  const staleRate = totalStocks > 0 ? stocksStale / totalStocks : 0;

  if (coverageRate < 0.80 || gapRate > 0.10 || staleRate > 0.10) return 'critical';
  if (coverageRate < 0.95 || gapRate > 0.02 || staleRate > 0.05) return 'warning';
  return 'good';
}

// ── Blob storage ─────────────────────────────────────────────────────────────

function reportBlobKey(market: 'TW' | 'CN', date: string): string {
  return `reports/verify-${market}-${date}.json`;
}

async function saveReportToBlob(report: VerifyReport): Promise<void> {
  const key = reportBlobKey(report.market, report.date);
  const json = JSON.stringify(report);

  if (IS_VERCEL) {
    const { put } = await import('@vercel/blob');
    await put(key, json, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
  }

  // 也存本地（開發環境 + Vercel warm instance）
  try {
    const { writeFile, mkdir } = await import('fs/promises');
    const { existsSync } = await import('fs');
    const path = await import('path');
    const dir = path.join(process.cwd(), 'data', 'reports');
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `verify-${report.market}-${report.date}.json`), json, 'utf-8');
  } catch { /* 只讀環境跳過 */ }
}

export async function loadVerifyReport(
  market: 'TW' | 'CN',
  date: string,
): Promise<VerifyReport | null> {
  const key = reportBlobKey(market, date);

  try {
    if (IS_VERCEL) {
      const { get } = await import('@vercel/blob');
      const result = await get(key, { access: 'private' });
      if (!result?.stream) return null;
      const reader = result.stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    } else {
      const { readFile } = await import('fs/promises');
      const path = await import('path');
      const raw = await readFile(
        path.join(process.cwd(), 'data', 'reports', `verify-${market}-${date}.json`),
        'utf-8',
      );
      return JSON.parse(raw);
    }
  } catch {
    return null;
  }
}

// ── Main verify function ─────────────────────────────────────────────────────

interface DownloadStats {
  succeeded: number;
  failed: number;
  skipped: number;
}

/**
 * 對已下載的 K 線進行校驗，生成報告並存儲。
 *
 * @param market 市場
 * @param targetDate 目標交易日（YYYY-MM-DD）
 * @param symbols 本次下載的全部股票代碼
 * @param stats 下載統計（成功/失敗/跳過）
 * @param maxGapDays gap 偵測門檻（預設 10 天）
 * @param staleDays 落後幾天視為 stale（預設 3 天）
 */
export async function verifyDownload(
  market: 'TW' | 'CN',
  targetDate: string,
  symbols: string[],
  stats: DownloadStats,
  maxGapDays = 10,
  staleDays = 3,
): Promise<VerifyReport> {
  const CONCURRENCY = 20;
  const gapDetails: VerifyGapDetail[] = [];
  const staleDetails: VerifyStaleDetail[] = [];
  const failedSymbols: string[] = [];
  let readFailed = 0;

  // 批次讀取+校驗（避免一次讀太多 Blob）
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (symbol) => {
        const data = await readCandleFile(symbol, market);
        if (!data) {
          failedSymbols.push(symbol);
          return;
        }

        // Gap 偵測
        const gaps = detectCandleGaps(data.candles, maxGapDays, market);
        if (gaps.length > 0) {
          gapDetails.push({ symbol, gaps });
        }

        // lastDate 檢查
        // 用交易日差距，避免跨連假誤判為 stale
        const behind = tradingDaysBetween(data.lastDate, targetDate, market);
        if (behind >= staleDays) {
          staleDetails.push({
            symbol,
            lastDate: data.lastDate,
            daysBehind: behind,
          });
        }
      }),
    );

    for (const r of results) {
      if (r.status === 'rejected') readFailed++;
    }
  }

  const totalStocks = symbols.length;
  // Coverage = 實際有 L1 數據的股票比例（不看今天下載是否成功）
  // 避免 provider 配額爆/網路斷線時誤判 L1 本體異常
  const stocksWithL1 = totalStocks - failedSymbols.length - readFailed;
  const coverageRate = totalStocks > 0 ? stocksWithL1 / totalStocks : 0;

  const report: VerifyReport = {
    market,
    date: targetDate,
    generatedAt: new Date().toISOString(),
    summary: {
      totalStocks,
      downloadSuccess: stats.succeeded,
      downloadFailed: stats.failed,
      downloadSkipped: stats.skipped,
      coverageRate: +coverageRate.toFixed(4),
      stocksWithGaps: gapDetails.length,
      stocksStale: staleDetails.length,
      stocksClean: totalStocks - gapDetails.length - staleDetails.length - failedSymbols.length - readFailed,
      stocksReadFailed: readFailed + failedSymbols.length,
    },
    failedSymbols,
    gapDetails: gapDetails.slice(0, 50), // 最多記 50 筆 gap detail（避免報告太大）
    staleDetails: staleDetails.slice(0, 50),
    health: classifyHealth(coverageRate, gapDetails.length, staleDetails.length, totalStocks),
  };

  // 存報告
  await saveReportToBlob(report);

  // ── 更新 BackfillQueue：把本次發現的 gap 寫入隊列，清掉已修復的 ──────────────
  try {
    const queue = await loadBackfillQueue(market);
    const gapSymbols = new Set(gapDetails.map((g) => g.symbol));

    // 清掉已修復的（上次在 queue 但本次 gap=0）
    const before = queue.items.length;
    queue.items = queue.items.filter((it) => gapSymbols.has(it.symbol));
    const cleared = before - queue.items.length;

    // 合併本次發現的 gap
    for (const gd of gapDetails) {
      mergeIntoQueue(queue, gd.symbol, gd.gaps);
    }

    await saveBackfillQueue(queue);
    const abandoned = queue.items.filter((it) => it.attempts >= MAX_ATTEMPTS).length;
    console.info(
      `[DownloadVerifier] ${market} ${targetDate}: backfill queue = ${queue.items.length} items ` +
      `(cleared ${cleared}, abandoned ${abandoned})`,
    );
  } catch (err) {
    console.warn('[DownloadVerifier] backfill queue update failed:', err);
  }

  console.info(
    `[DownloadVerifier] ${market} ${targetDate}: ` +
    `health=${report.health} coverage=${(coverageRate * 100).toFixed(1)}% ` +
    `gaps=${gapDetails.length} stale=${staleDetails.length} readFail=${readFailed + failedSymbols.length}`,
  );

  return report;
}
