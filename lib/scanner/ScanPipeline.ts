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
  /** 獨立買法掃描（不過 A 六條件，全市場各自偵測） */
  buyMethods?: ('B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H')[];
  /** 顯式指定策略（歷史重跑用），不指定時從 server-side 讀 active strategy */
  strategy?: import('@/lib/strategy/StrategyConfig').StrategyConfig;
  /** 顯式指定歷史 turnoverRank（歷史重跑用，避免用到今天的前 500） */
  turnoverRankOverride?: Map<string, number>;
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

  // ── Step 1: 建立 Scanner + L2 注入 + 讀取 active strategy ──
  // 動態 import 避免 Edge runtime 解析到 fs/path
  const { saveScanSession, loadScanSession } = await import('@/lib/storage/scanStorage');
  const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
  const { getActiveStrategyServer } = await import('@/lib/strategy/activeStrategyServer');

  // Server-side active strategy（UI 切策略時會同步寫入）
  const activeStrategy = options.strategy ?? await getActiveStrategyServer();
  const activeThresholds = activeStrategy.thresholds;
  console.info(`[ScanPipeline] ${market} 使用策略: ${activeStrategy.id} (${activeStrategy.name})`);

  let scanner: TaiwanScanner | ChinaScanner;
  if (market === 'CN') {
    const { ChinaScanner: CS } = await import('./ChinaScanner');
    scanner = new CS();
  } else {
    const { TaiwanScanner: TS } = await import('./TaiwanScanner');
    scanner = new TS();
  }
  // L1 記憶體快取預熱（fire-and-forget，本地開發用，Vercel 自動跳過）
  // 首掃時：在掃描期間背景讀進記憶體（後半段掃描命中快取）
  // 二掃起：全部命中快取，消除 disk I/O + JSON.parse（CN 省 ~16s）
  const { triggerPreload: triggerL1 } = await import('@/lib/datasource/L1CandleCache');
  triggerL1(market as 'TW' | 'CN');

  const l2Injected = await injectL2(scanner, market, date, readIntradaySnapshot);

  // ── Step 2: 取得股票清單（前 N 成交額過濾 + 批次切片） ──
  let stocks = await scanner.getStockList();

  // Fail-closed：TWSE/TPEx API 失敗時 getStockList() 回傳 30 支 FALLBACK_TW_STOCKS，
  // 若不擋會把 top500 索引重建成 30 支，造成 post_close totalScanned=30, rc=0 覆蓋正確 intraday
  const MIN_STOCK_COUNT = market === 'TW' ? 200 : 500;
  if (stocks.length < MIN_STOCK_COUNT && !options.turnoverRankOverride) {
    throw new Error(
      `[ScanPipeline] ${market} getStockList 只回傳 ${stocks.length} 支（< ${MIN_STOCK_COUNT}），` +
      `疑似 API 失敗 fallback，abort 掃描避免覆蓋正確 L4`
    );
  }

  let turnoverRanks: Map<string, number> | null = null;

  if (options.turnoverRankOverride) {
    // 歷史重跑路徑：caller 已用 computeTurnoverRankAsOfDate 算好當日的前 500
    const before = stocks.length;
    stocks = stocks.filter(s => options.turnoverRankOverride!.has(s.symbol));
    turnoverRanks = options.turnoverRankOverride;
    console.info(`[ScanPipeline] ${market} 歷史 top500 override: ${stocks.length}/${before} (asOfDate=${date})`);
  } else {
    // 標準路徑：前 N 成交額過濾 + 自動重建索引（回測冠軍組合：前 500 + MTF≥3 = +238%）
    // 索引 stale 時自動重建（本地 fs / Vercel Blob 統一處理）
    // Fail-closed: 索引讀/建失敗 → abort 掃描，不回退到「無過濾全掃」
    const { readTurnoverRank, buildTurnoverRank } = await import('./TurnoverRank');
    let rank: Awaited<ReturnType<typeof readTurnoverRank>> = null;
    try {
      rank = await readTurnoverRank(market as 'TW' | 'CN');
      const needsRebuild = !rank || rank.date < date;
      if (needsRebuild) {
        console.info(`[ScanPipeline] ${market} 索引 stale（have=${rank?.date ?? 'none'}, want=${date}）→ 自動重建`);
        await buildTurnoverRank(market as 'TW' | 'CN', stocks, 500);
        rank = await readTurnoverRank(market as 'TW' | 'CN');
      }
    } catch (err) {
      console.error(`[ScanPipeline] ${market} top500 索引讀/建失敗 → abort`, err);
      throw new Error(`top500 索引失敗，掃描 abort (${market} ${date}): ${String(err)}`);
    }
    if (!rank || rank.symbols.size === 0) {
      console.error(`[ScanPipeline] ${market} top500 索引空或 null → abort`);
      throw new Error(`top500 索引空 (${market} ${date})`);
    }
    const before = stocks.length;
    stocks = stocks.filter(s => rank!.symbols.has(s.symbol));
    turnoverRanks = rank.ranks;
    console.info(`[ScanPipeline] ${market} 前 ${rank.topN} 成交額過濾: ${stocks.length}/${before} (index=${rank.date})`);
  }

  // buyMethods 需要全量股票，在批次切片前先保存
  const allStocks = stocks;

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
        const out = await scanner.scanSOP(stocks, date, activeThresholds);
        results = out.results as import('./types').StockScanResult[];
        sessionFreshness = out.sessionFreshness;
        if (!marketTrend) marketTrend = String(out.marketTrend ?? '');
      } else {
        const out = await scanner.scanShortCandidates(stocks, date, activeThresholds);
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

      // 注入前向績效（openReturn / d1Return / maxGain / ... ）
      // 讓 L4 session 寫入時就帶好「可否進場」資訊，前端不用每次重算
      if (results.length > 0) {
        try {
          const { analyzeForwardBatch } = await import('@/lib/backtest/ForwardAnalyzer');
          const fwdInput = results.map(r => ({ symbol: r.symbol, name: r.name, scanPrice: r.price }));
          const { results: fwdPerf } = await analyzeForwardBatch(fwdInput, date);
          const fwdMap = new Map(fwdPerf.map(p => [p.symbol, p]));
          for (const r of results) {
            const p = fwdMap.get(r.symbol);
            if (!p) continue;
            r.openReturn        = p.openReturn;
            r.d1Return          = p.d1Return;
            r.d2Return          = p.d2Return;
            r.d3Return          = p.d3Return;
            r.d4Return          = p.d4Return;
            r.d5Return          = p.d5Return;
            r.d6Return          = p.d6Return;
            r.d7Return          = p.d7Return;
            r.d8Return          = p.d8Return;
            r.d9Return          = p.d9Return;
            r.d10Return         = p.d10Return;
            r.d20Return         = p.d20Return;
            r.maxGain           = p.maxGain;
            r.maxLoss           = p.maxLoss;
            r.nextOpenPrice     = p.nextOpenPrice;
            r.d1ReturnFromOpen  = p.d1ReturnFromOpen;
          }
          console.info(`[ScanPipeline] ${market} ${direction} 注入 forward: ${fwdPerf.length}/${results.length}`);
        } catch (err) {
          console.warn(`[ScanPipeline] ${market} ${direction} forward 注入失敗（non-fatal）:`, err);
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
          marketTrend,
          dataFreshness: sessionFreshness,
        };
        await saveScanSession(dailySession, { allowOverwritePostClose: allowOverwrite });
        counts[`${direction}-daily`] = results.length;
      }

      // ── Step 4b: 存 mtf session（週線前5全過才算通過，用 mtfWeeklyPass 而非舊 4 分制 mtfScore）──
      if (wantMtf) {
        const mtfResults = results.filter(r => r.mtfWeeklyPass === true);
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
          marketTrend,
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

  // ── Step 5: 獨立買法掃描（B/C/D/E，不過 A 六條件） ──────────────────
  // 批次模式下只在最後一批執行，且用全量股票（避免分批存入 session 互相覆蓋）
  const isLastBatch = !batch || !totalBatches || batch === totalBatches;
  if (options.buyMethods?.length && !timedOut && isLastBatch) {
    const bmStocks = allStocks; // 全量，不受批次切片影響
    for (const method of options.buyMethods) {
      if (Date.now() > deadline) {
        console.warn(`[ScanPipeline] ${market} 超時，跳過買法 ${method}`);
        timedOut = true;
        break;
      }
      try {
        const bmResults = await scanner.scanBuyMethod(method, bmStocks, date);

        if (turnoverRanks) {
          for (const r of bmResults) {
            const rank = turnoverRanks.get(r.symbol);
            if (rank) r.turnoverRank = rank;
          }
        }

        const bmSession: ScanSession = {
          id: `${market}-long-${method}-${date}-${Date.now()}`,
          market: market as MarketId,
          date,
          direction: 'long',
          multiTimeframeEnabled: false,
          sessionType,
          scanTime: new Date().toISOString(),
          resultCount: bmResults.length,
          results: bmResults,
          marketTrend,
          buyMethod: method as 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H',
        };
        await saveScanSession(bmSession, { allowOverwritePostClose: sessionType === 'post_close' });
        counts[`long-${method}`] = bmResults.length;
        console.info(`[ScanPipeline] ${market} 買法 ${method}: ${bmResults.length} 檔`);
      } catch (err) {
        console.error(`[ScanPipeline] ${market} 買法 ${method} 失敗:`, err);
        counts[`long-${method}`] = 0;
      }
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
