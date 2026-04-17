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
  const { ZHU_OPTIMIZED } = await import('@/lib/strategy/StrategyConfig');

  let scanner: TaiwanScanner | ChinaScanner;
  if (market === 'CN') {
    const { ChinaScanner: CS } = await import('./ChinaScanner');
    scanner = new CS();
  } else {
    const { TaiwanScanner: TS } = await import('./TaiwanScanner');
    scanner = new TS();
  }
  const l2Injected = await injectL2(scanner, market, date, readIntradaySnapshot);

  // ── Step 2: 取得股票清單（前 N 成交額過濾 + 批次切片） ──
  let stocks = await scanner.getStockList();
  let turnoverRanks: Map<string, number> | null = null;

  // 前 N 成交額過濾 + 自動重建索引（回測冠軍組合：前 500 + MTF≥3 = +238%）
  // 索引 stale 時自動重建（本地 fs / Vercel Blob 統一處理）
  try {
    const { readTurnoverRank, buildTurnoverRank } = await import('./TurnoverRank');
    let rank = await readTurnoverRank(market as 'TW' | 'CN');
    const needsRebuild = !rank || rank.date < date;
    if (needsRebuild) {
      console.info(`[ScanPipeline] ${market} 索引 stale（have=${rank?.date ?? 'none'}, want=${date}）→ 自動重建`);
      await buildTurnoverRank(market as 'TW' | 'CN', stocks, 500);
      rank = await readTurnoverRank(market as 'TW' | 'CN');
    }
    if (rank) {
      const before = stocks.length;
      stocks = stocks.filter(s => rank.symbols.has(s.symbol));
      turnoverRanks = rank.ranks;
      console.info(`[ScanPipeline] ${market} 前 ${rank.topN} 成交額過濾: ${stocks.length}/${before} (index=${rank.date})`);
    }
  } catch (err) {
    console.warn(`[ScanPipeline] ${market} top500 索引讀寫失敗:`, err);
    // 索引檔讀寫失敗 — 不過濾，走原邏輯
  }

  if (batch && totalBatches && totalBatches > 1) {
    const sorted = [...stocks].sort((a, b) => a.symbol.localeCompare(b.symbol));
    const chunkSize = Math.ceil(sorted.length / totalBatches);
    stocks = sorted.slice((batch - 1) * chunkSize, batch * chunkSize);
    console.info(`[ScanPipeline] ${market} batch ${batch}/${totalBatches}: ${stocks.length} 支`);
  }

  // ── Step 3: 掃描（每個 direction 只跑一次 daily，mtf 從結果 filter） ──
  // 性能優化：daily 和 mtf 結果差異只在前置 MTF 過濾（mtfScore >= mtfMinScore）。
  // 而 mtfResult always 計算（MarketScanner.scanOne），所以可以一次掃描共用兩份結果。
  // CN 3121 支從原本 4 次掃描（~380s）降為 2 次（~190s），避開 Vercel 300s 限制。
  const mtfMinScore = ZHU_OPTIMIZED.thresholds.mtfMinScore ?? 3;
  const wantDaily = mtfModes.includes('daily');
  const wantMtf = mtfModes.includes('mtf');

  for (const direction of directions) {
    if (Date.now() > deadline) {
      console.warn(`[ScanPipeline] ${market} 超時，跳過 ${direction}`);
      timedOut = true;
      break;
    }

    // 跳過已存在的結果（除非 force）— 只對 post_close 做 dedup，
    // intraday 必須每次重跑（盤中即時刷新，不能因為昨日/凌晨已寫 post_close 就跳過）
    if (!force && sessionType === 'post_close') {
      const existingDaily = wantDaily ? await loadScanSession(market as MarketId, date, direction, 'daily') : null;
      const existingMtf = wantMtf ? await loadScanSession(market as MarketId, date, direction, 'mtf') : null;
      const dailyOk = !wantDaily || (existingDaily && existingDaily.resultCount >= 0);
      const mtfOk = !wantMtf || (existingMtf && existingMtf.resultCount >= 0);
      if (dailyOk && mtfOk) {
        if (existingDaily) counts[`${direction}-daily`] = existingDaily.resultCount;
        if (existingMtf) counts[`${direction}-mtf`] = existingMtf.resultCount;
        const reuseSummary = [
          existingDaily ? `daily=${existingDaily.resultCount}` : '',
          existingMtf ? `mtf=${existingMtf.resultCount}` : '',
        ].filter(Boolean).join(' ');
        console.info(`[ScanPipeline] ⏭️ ${market} ${direction} dedup 跳過 (${reuseSummary})`);
        continue;
      }
    }

    try {
      // 一次性掃描（不前置 MTF 過濾，daily 模式）
      let results: import('./types').StockScanResult[];
      let sessionFreshness: ScanSession['dataFreshness'];

      if (direction === 'long') {
        const out = await scanner.scanSOP(stocks, date, undefined);
        results = out.results as import('./types').StockScanResult[];
        sessionFreshness = out.sessionFreshness;
        if (!marketTrend) marketTrend = String(out.marketTrend ?? '');
      } else {
        const out = await scanner.scanShortCandidates(stocks, date, undefined);
        results = out.candidates;
        sessionFreshness = out.sessionFreshness;
        if (!marketTrend) marketTrend = String(out.marketTrend ?? '');
      }

      // 注入成交額排名（供 UI 顯示「成交量#N」標註）
      if (turnoverRanks) {
        for (const r of results) {
          const rank = turnoverRanks.get(r.symbol);
          if (rank) r.turnoverRank = rank;
        }
      }

      const allowOverwrite = sessionType === 'post_close';

      // ── Step 4a: 存 daily session（完整結果）──
      if (wantDaily) {
        const dailySession: ScanSession = {
          id: `${prefix}-${direction}-daily-${date}-${batch ? `b${batch}-` : ''}${Date.now()}`,
          market: market as MarketId,
          date,
          direction,
          multiTimeframeEnabled: false,
          sessionType,
          scanTime: new Date().toISOString(),
          resultCount: results.length,
          results,
          dataFreshness: sessionFreshness,
        };
        await saveScanSession(dailySession, { allowOverwritePostClose: allowOverwrite });
        counts[`${direction}-daily`] = results.length;
      }

      // ── Step 4b: 存 mtf session（從 daily 結果 filter mtfScore >= mtfMinScore）──
      if (wantMtf) {
        const mtfResults = results.filter(r => (r.mtfScore ?? 0) >= mtfMinScore);
        const mtfSession: ScanSession = {
          id: `${prefix}-${direction}-mtf-${date}-${batch ? `b${batch}-` : ''}${Date.now() + 1}`,
          market: market as MarketId,
          date,
          direction,
          multiTimeframeEnabled: true,
          sessionType,
          scanTime: new Date().toISOString(),
          resultCount: mtfResults.length,
          results: mtfResults,
          dataFreshness: sessionFreshness,
        };
        await saveScanSession(mtfSession, { allowOverwritePostClose: allowOverwrite });
        counts[`${direction}-mtf`] = mtfResults.length;
      }
    } catch (err) {
      console.error(`[ScanPipeline] ${market} ${direction} 失敗:`, err);
      if (wantDaily) counts[`${direction}-daily`] = 0;
      if (wantMtf) counts[`${direction}-mtf`] = 0;
    }
  }

  // ── Log（區分真跑 vs dedup 跳過 vs 超時，避免靜默失敗誤判）──
  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
  const tag = timedOut ? '⚠️超時' : sessionType === 'intraday' ? '🔄intraday' : '✅post_close';
  console.info(
    `[ScanPipeline] ${tag} ${market}${batch ? ` b${batch}/${totalBatches}` : ''} ` +
    `trend=${marketTrend ?? '?'} ${summary} L2=${l2Injected}`,
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
