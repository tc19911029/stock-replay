/**
 * ScanPipeline — 統一掃描管線
 *
 * 所有掃描入口（Vercel cron / 本地 instrumentation / daily-scan 腳本）
 * 都調用這一個函數，不再各自實作 L2 注入 + 掃描 + 存 L4 的重複邏輯。
 *
 * 支援：
 *   - 批次分割（CN 在 Vercel 300s 限制下拆 4 批）
 *   - 超時保護（deadline 到了提前返回）
 *   - L2 記憶體注入（盤中/盤後統一）
 */

import type { ScanSession, MarketId, ScanDirection } from './types';
import type { TaiwanScanner } from './TaiwanScanner';
import type { ChinaScanner } from './ChinaScanner';

// ── Types ───────────────────────────────────────────────────────────────

export interface ScanPipelineOptions {
  market: 'TW' | 'CN';
  date: string;
  sessionType: 'post_close' | 'intraday';
  directions: ScanDirection[];
  mtfModes: ('daily' | 'mtf')[];
  /** CN 批次分割（Vercel 用） */
  batch?: number;
  totalBatches?: number;
  /** 強制覆蓋已有結果 */
  force?: boolean;
  /** 超時毫秒數（預設 250000） */
  deadlineMs?: number;
}

export interface ScanPipelineResult {
  market: string;
  date: string;
  counts: Record<string, number>;
  marketTrend?: string;
  l2Injected: number;
  batch?: number;
  totalBatches?: number;
  timedOut?: boolean;
}

// ── Main Pipeline ───────────────────────────────────────────────────────

export async function runScanPipeline(options: ScanPipelineOptions): Promise<ScanPipelineResult> {
  const {
    market, date, sessionType, directions, mtfModes,
    batch, totalBatches, force = false,
    deadlineMs = 250_000,
  } = options;

  const deadline = Date.now() + deadlineMs;
  const prefix = market;
  const counts: Record<string, number> = {};
  let marketTrend: string | undefined;
  let timedOut = false;

  // ── Step 1: 建立 Scanner + L2 注入 ──
  // 動態 import 避免 Edge runtime 解析到 fs/path
  const { saveScanSession, loadScanSession } = await import('@/lib/storage/scanStorage');
  const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
  const { ZHU_V1 } = await import('@/lib/strategy/StrategyConfig');

  let scanner: TaiwanScanner | ChinaScanner;
  if (market === 'CN') {
    const { ChinaScanner: CS } = await import('./ChinaScanner');
    scanner = new CS();
  } else {
    const { TaiwanScanner: TS } = await import('./TaiwanScanner');
    scanner = new TS();
  }
  const l2Injected = await injectL2(scanner, market, date, readIntradaySnapshot);

  // ── Step 2: 取得股票清單（支援批次切片） ──
  let stocks = await scanner.getStockList();
  if (batch && totalBatches && totalBatches > 1) {
    const sorted = [...stocks].sort((a, b) => a.symbol.localeCompare(b.symbol));
    const chunkSize = Math.ceil(sorted.length / totalBatches);
    stocks = sorted.slice((batch - 1) * chunkSize, batch * chunkSize);
    console.info(`[ScanPipeline] ${market} batch ${batch}/${totalBatches}: ${stocks.length} 支`);
  }

  // ── Step 3: 掃描（遍歷 directions × mtfModes） ──
  for (const direction of directions) {
    for (const mode of mtfModes) {
      // 超時保護
      if (Date.now() > deadline) {
        console.warn(`[ScanPipeline] ${market} 超時，跳過 ${direction}-${mode}`);
        timedOut = true;
        break;
      }

      const key = `${direction}-${mode}`;
      const mtfEnabled = mode === 'mtf';

      // 跳過已有結果（除非 force）
      if (!force) {
        const existing = await loadScanSession(market as MarketId, date, direction, mode);
        if (existing && existing.resultCount >= 0) {
          counts[key] = existing.resultCount;
          continue;
        }
      }

      try {
        const thresholds = mtfEnabled
          ? { ...ZHU_V1.thresholds, multiTimeframeFilter: true }
          : undefined;

        let results: import('./types').StockScanResult[];
        let sessionFreshness: ScanSession['dataFreshness'];

        if (direction === 'long') {
          const out = await scanner.scanSOP(stocks, date, thresholds);
          results = out.results as import('./types').StockScanResult[];
          sessionFreshness = out.sessionFreshness;
          if (!marketTrend) marketTrend = String(out.marketTrend ?? '');
        } else {
          const out = await scanner.scanShortCandidates(stocks, date, thresholds);
          results = out.candidates;
          sessionFreshness = out.sessionFreshness;
          if (!marketTrend) marketTrend = String(out.marketTrend ?? '');
        }

        // ── Step 4: 存 L4 ──
        const session: ScanSession = {
          id: `${prefix}-${direction}-${mode}-${date}-${batch ? `b${batch}-` : ''}${Date.now()}`,
          market: market as MarketId,
          date,
          direction,
          multiTimeframeEnabled: mtfEnabled,
          sessionType,
          scanTime: new Date().toISOString(),
          resultCount: results.length,
          results,
          dataFreshness: sessionFreshness,
        };

        const allowOverwrite = sessionType === 'post_close';
        await saveScanSession(session, { allowOverwritePostClose: allowOverwrite });
        counts[key] = results.length;
      } catch (err) {
        console.error(`[ScanPipeline] ${market} ${key} 失敗:`, err);
        counts[key] = 0;
      }
    }
    if (timedOut) break;
  }

  // ── Log ──
  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
  console.info(
    `[ScanPipeline] ${market}${batch ? ` b${batch}/${totalBatches}` : ''} ` +
    `完成: trend=${marketTrend ?? '?'} ${summary} L2=${l2Injected}${timedOut ? ' ⚠️超時' : ''}`,
  );

  return { market, date, counts, marketTrend, l2Injected, batch, totalBatches, timedOut };
}

// ── L2 注入（統一函數） ─────────────────────────────────────────────────

async function injectL2(
  scanner: TaiwanScanner | ChinaScanner,
  market: 'TW' | 'CN',
  date: string,
  readIntradaySnapshot: (market: 'TW' | 'CN', date: string) => Promise<{ quotes: { symbol: string; open: number; high: number; low: number; close: number; volume: number }[]; date: string } | null>,
): Promise<number> {
  try {
    const snap = await readIntradaySnapshot(market, date);
    if (!snap || snap.quotes.length === 0) return 0;

    const realtimeQuotes = new Map<string, {
      open: number; high: number; low: number; close: number; volume: number; date?: string;
    }>();
    const suffix = market === 'TW' ? /\.(TW|TWO)$/i : /\.(SS|SZ)$/i;

    for (const q of snap.quotes) {
      if (q.close > 0) {
        realtimeQuotes.set(q.symbol.replace(suffix, ''), {
          open: q.open, high: q.high, low: q.low,
          close: q.close, volume: q.volume, date: snap.date,
        });
      }
    }

    if (realtimeQuotes.size > 0) {
      scanner.setRealtimeQuotes(realtimeQuotes);
      console.info(`[ScanPipeline] ${market} L2 注入 ${realtimeQuotes.size} 支 (${snap.date})`);
    }
    return realtimeQuotes.size;
  } catch {
    console.warn(`[ScanPipeline] ${market} L2 注入失敗`);
    return 0;
  }
}
