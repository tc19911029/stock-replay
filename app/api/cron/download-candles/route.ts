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
import { suspectsLimitOverwrite } from '@/lib/datasource/limitMoveGuard';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { readIntradaySnapshot, IntradayQuote } from '@/lib/datasource/IntradayCache';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { saveDownloadManifest } from '@/lib/datasource/DownloadManifest';
import { verifyDownload } from '@/lib/datasource/DownloadVerifier';
import { spotCheckL1 } from '@/lib/datasource/L1SpotCheck';
import { checkCronAuth } from '@/lib/api/cronAuth';
import {
  loadBackfillQueue,
  saveBackfillQueue,
  markAttempt,
  removeFromQueue,
  MAX_ATTEMPTS,
} from '@/lib/datasource/BackfillQueue';
import { dataProvider } from '@/lib/datasource/MultiMarketProvider';
import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';

// ── TWSE MI_INDEX 官方日收盤（上市，集合競價後才更新） ───────────────────────────

interface BulkOHLCV { open: number; high: number; low: number; close: number; volume: number; }

/**
 * 抓 TWSE MI_INDEX table 8「每日收盤行情」，一次取所有上市股票的官方 OHLCV。
 * 用來替代 L2 盤中快照，避免集合競價前的快照寫入錯誤收盤價。
 */
async function fetchTWSEBulkClose(dateStr: string): Promise<Map<string, BulkOHLCV>> {
  const d = dateStr.replace(/-/g, ''); // "2026-04-29" → "20260429"
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${d}&type=ALLBUT0999`;
  // 2026-05-11：Node fetch 對 www.twse.com.tw 也可能被 Cloudflare 擋，走 fetchJsonWithCurlFallback
  const { data, source } = await fetchJsonWithCurlFallback<{ stat: string; tables: Array<{ fields: string[]; data: string[][] }> }>(
    url, { timeoutMs: 30_000 },
  );
  if (source === 'curl') console.info('[download-candles] TWSE MI_INDEX 經 curl fallback 成功');
  if (data.stat !== 'OK') throw new Error(`TWSE MI_INDEX stat=${data.stat}`);
  const table = data.tables?.[8];
  if (!table?.data?.length) throw new Error('TWSE MI_INDEX table 8 missing or empty');

  const parseNum = (s: string) => { const n = parseFloat(s.replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const map = new Map<string, BulkOHLCV>();
  for (const row of table.data) {
    const code = row[0]?.trim();
    if (!code || !/^\d{4,}[A-Z]?$/.test(code)) continue; // 只要 4~5 位數字（含 ETF 如 00400A）
    const open  = parseNum(row[5]);
    const high  = parseNum(row[6]);
    const low   = parseNum(row[7]);
    const close = parseNum(row[8]);
    const volume = Math.round(parseNum(row[2]) / 1000); // 股 → 張
    if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
  }
  return map;
}

// ── TPEx 上櫃官方日收盤（集合競價後才更新）──────────────────────────────────
/**
 * 抓 TPEx OpenAPI tpex_mainboard_quotes，所有上櫃股票最新交易日 OHLCV。
 * 跟 TWSE MI_INDEX 平行，給 .TWO 上櫃股當 ground truth 安全網。
 *
 * 注意：endpoint 只回最新交易日資料（不能指定歷史日期）；用 dateStr 比對 row.Date
 *      確保抓到的是目標交易日。TPEx 結算約 14:00 CST 完成。
 */
interface TPExRawRow {
  Date?: string; SecuritiesCompanyCode?: string;
  Open?: string; High?: string; Low?: string; Close?: string;
  TradingShares?: string;
}
function parseROCDateLocal(raw?: string): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const yyyy = String(parseInt(m[1], 10) + 1911);
  return `${yyyy}-${m[2]}-${m[3]}`;
}
async function fetchTPExBulkClose(targetDate: string): Promise<Map<string, BulkOHLCV>> {
  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes';
  // 2026-05-11：Node fetch 對 TPEx 被 Cloudflare 擋（5/11 cron 漏 853 支上櫃的元兇），走 curl fallback
  const { data: rows, source } = await fetchJsonWithCurlFallback<TPExRawRow[]>(url, { timeoutMs: 30_000 });
  if (source === 'curl') console.info('[download-candles] TPEx OpenAPI 經 curl fallback 成功');
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('TPEx OpenAPI empty');

  const parseNum = (s?: string) => { if (!s) return 0; const n = parseFloat(s.replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const map = new Map<string, BulkOHLCV>();
  let dateMatched = 0;
  for (const row of rows) {
    const code = row.SecuritiesCompanyCode?.trim();
    if (!code || !/^\d{4,5}[A-Z]?$/.test(code)) continue;
    // 只接受目標日的資料（避免跑在交易日 cron 太早撈到前一日 stale 結果）
    const rowDate = parseROCDateLocal(row.Date);
    if (rowDate !== targetDate) continue;
    dateMatched++;
    const open = parseNum(row.Open);
    const high = parseNum(row.High);
    const low = parseNum(row.Low);
    const close = parseNum(row.Close);
    const volume = Math.round(parseNum(row.TradingShares) / 1000); // 股 → 張
    if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
  }
  if (dateMatched === 0) throw new Error(`TPEx OpenAPI 無 ${targetDate} 資料（可能還沒結算）`);
  return map;
}

export const runtime = 'nodejs';
export const maxDuration = 300;

const CONCURRENCY = 8;
const BATCH_DELAY_MS = 300;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function GET(req: NextRequest) {
  // 驗證 cron secret
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

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

    // Stocklist size sanity check：5/11 教訓 — cron 14:37 CST 跑時 TPEx openapi 暫時掛掉，
    // stocklist 只回上市 1077（少了 853 支上櫃），但 ScanPipeline 安全閘 (200) 沒擋住，
    // 結果 853 支上櫃股的 5/11 row 完全沒下載。這裡用近期 manifest 平均 vs 本次大小做監測。
    try {
      const expectedMin = market === 'TW' ? 1500 : 2700;
      if (stocks.length < expectedMin) {
        console.warn(
          `[download-candles] ${market}: ⚠ stocklist=${stocks.length} 顯著小於預期 ≥${expectedMin}，` +
          `可能 provider transient 失效（TPEx/EastMoney 階段性掛掉）。此次 cron 將只下載到的部分，` +
          `下一輪 cron 或 BackfillQueue 會補。`
        );
      }
    } catch { /* sanity check 失敗不擋主流程 */ }

    // ── Step -1: 消費 Backfill Queue（上輪 verify 發現缺棒的股票，針對性補拉） ──
    // 在主下載之前跑，補拉也會觸發 writeCandleFile merge，讓主下載看到已補齊狀態。
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
      // 寫回 attempts 計數（成功項已即時從 queue 移除）
      await saveBackfillQueue(queue);
      if (backfillFilled > 0 || backfillFailed > 0) {
        console.info(
          `[download-candles] ${market}: backfill 完成 — ${backfillFilled} 補齊, ${backfillFailed} 失敗, ${backfillSkipped} 跳過`,
        );
      }
    } catch (err) {
      console.warn('[download-candles] backfill consume failed:', err);
    }

    // ── TW 上市：TWSE MI_INDEX 官方日收盤（集合競價後才更新，是唯一正確來源）──
    // 取代 L2 盤中快照，避免快照在集合競價完成前就注入錯誤收盤價
    let twseMap: Map<string, BulkOHLCV> | null = null;
    let twseInjected = 0;
    if (market === 'TW') {
      try {
        twseMap = await fetchTWSEBulkClose(lastTradingDate);
        console.info(`[download-candles] TW: TWSE MI_INDEX 官方收盤已載入 ${twseMap.size} 支上市股票`);
      } catch (err) {
        console.warn('[download-candles] TW: TWSE MI_INDEX 載入失敗，改用 L2+API fallback:', err);
      }
    }

    // ── TW 上櫃：TPEx OpenAPI 官方日收盤（給 .TWO 當 ground truth，平行 TWSE 安全網）──
    // 0510 加：原本 .TWO 只能靠 data provider，13:45 cron 抓到的可能是盤中快照
    let tpexMap: Map<string, BulkOHLCV> | null = null;
    let tpexInjected = 0;
    if (market === 'TW') {
      try {
        tpexMap = await fetchTPExBulkClose(lastTradingDate);
        console.info(`[download-candles] TW: TPEx OpenAPI 官方收盤已載入 ${tpexMap.size} 支上櫃股票`);
      } catch (err) {
        console.warn('[download-candles] TW: TPEx OpenAPI 載入失敗（可能還沒結算），改用 L2+API fallback:', err);
      }
    }

    // ── L2 快照（TWO 上櫃 fallback，或 TWSE 載入失敗時的備援）──
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

    console.info(
      `[download-candles] ${market}: ${stocks.length} 支，` +
      `TWSE=${twseMap?.size ?? 0}，TPEx=${tpexMap?.size ?? 0}，L2=${l2Map?.size ?? 0}`
    );

    // 收集每支失敗的 symbol + 原因，供 manifest 寫入（2026-05-11：原本只記計數
    // 導致 5/11 cron 失敗 5 支時根本不知道是哪 5 支）
    const failedSymbols: Array<{ symbol: string; reason: string }> = [];

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async ({ symbol }): Promise<number | { failed: true; reason: string }> => {
          const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
          const existing = await readCandleFile(symbol, market);

          // 已是最新，跳過
          if (existing && existing.lastDate >= lastTradingDate) return -1;

          // ── 優先路徑 1：TWSE 官方日收盤（只對上市 .TW 股票）──
          // 用集合競價後的官方 OHLCV，不受盤中快照時序影響
          if (symbol.endsWith('.TW') && twseMap) {
            const ohlcv = twseMap.get(code);
            if (ohlcv) {
              await saveLocalCandles(symbol, market, [{ date: lastTradingDate, ...ohlcv }]);
              twseInjected++;
              return 1;
            }
          }

          // ── 優先路徑 1b：TPEx 官方日收盤（只對上櫃 .TWO 股票）──
          if (symbol.endsWith('.TWO') && tpexMap) {
            const ohlcv = tpexMap.get(code);
            if (ohlcv) {
              await saveLocalCandles(symbol, market, [{ date: lastTradingDate, ...ohlcv }]);
              tpexInjected++;
              return 1;
            }
          }

          // ── 優先路徑 2：L2 快照（上櫃 TWO / CN，或 TWSE 無此股）──
          if (existing && existing.lastDate >= recentThresholdStr && l2Map) {
            const l2Quote = l2Map.get(code);
            if (l2Quote) {
              const prevBar = existing.candles[existing.candles.length - 1];
              if (suspectsLimitOverwrite(prevBar?.close, l2Quote, market, code)) {
                console.warn(
                  `[download-candles] ${symbol} ${lastTradingDate} L2 漲跌停 close 異常，` +
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

          // ── 全量 API 下載（L1 缺失、太舊、或兩個快照都無此股）──
          try {
            const candles = await scanner.fetchCandles(symbol);
            if (candles.length > 0) {
              await saveLocalCandles(symbol, market, candles);
              return candles.length;
            }
            // 拉到空陣列：所有 provider 都沒回 → 可能停牌或退市
            return { failed: true, reason: 'all-providers-empty' };
          } catch (err) {
            return { failed: true, reason: `fetch-error:${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}` };
          }
        })
      );

      for (let j = 0; j < settled.length; j++) {
        const r = settled[j];
        if (r.status === 'fulfilled') {
          const v = r.value;
          if (typeof v === 'number') {
            if (v === -1) skipped++;
            else if (v > 0) succeeded++;
            else failed++;
          } else {
            // 失敗物件
            failed++;
            failedSymbols.push({ symbol: batch[j].symbol, reason: v.reason });
          }
        } else {
          failed++;
          failedSymbols.push({
            symbol: batch[j].symbol,
            reason: `rejected:${r.reason instanceof Error ? r.reason.message.slice(0, 80) : String(r.reason).slice(0, 80)}`,
          });
        }
      }

      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);

      // 進度 log（每 100 檔印一次）
      if ((i + CONCURRENCY) % 100 < CONCURRENCY) {
        console.info(`[download-candles] ${market}: ${i + CONCURRENCY}/${stocks.length} (ok=${succeeded}, skip=${skipped}, fail=${failed})`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.info(
      `[download-candles] ${market}: 完成 — ${succeeded} API下載, ` +
      `${twseInjected} TWSE注入, ${tpexInjected} TPEx注入, ${l2Injected} L2注入, ${skipped} 跳過, ${failed} 失敗, ${duration}s`
    );

    // 保存下載清單（供掃描前檢查覆蓋率使用）
    await saveDownloadManifest(market, lastTradingDate, {
      total: stocks.length,
      succeeded,
      skipped,
      failed,
      coverage: Math.round((succeeded + skipped) / stocks.length * 100),
      durationSec: parseFloat(duration),
      failedSymbols: failedSymbols.length > 0 ? failedSymbols : undefined,
      stocklistSize: stocks.length,
    }).catch(err => console.warn('[download-candles] manifest save failed:', err));

    // 失敗 list 太長時印頭幾筆，方便排查
    if (failedSymbols.length > 0) {
      const preview = failedSymbols.slice(0, 10).map(f => `${f.symbol}(${f.reason.slice(0, 30)})`).join(', ');
      console.warn(`[download-candles] ${market}: ${failedSymbols.length} 支失敗，前 10：${preview}`);
    }

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

    // ── 最終守護：TWSE MI_INDEX 全量交叉稽核 + 自動修復（TW 上市專用）──
    // 防止：L2 注入或 API 下載寫入集合競價前的錯誤收盤價
    // 機制：對所有有 TWSE 官方資料的 .TW 股票，比對 L1 vs 官方，偏差 > 0.5% 自動覆寫
    let twseAudit: { checked: number; repaired: number; samples: string[] } | undefined;
    if (market === 'TW' && twseMap) {
      let checked = 0, repaired = 0;
      const samples: string[] = [];
      for (const stock of stocks) {
        if (!stock.symbol.endsWith('.TW')) continue;
        const code = stock.symbol.replace(/\.TW$/i, '');
        const official = twseMap.get(code);
        if (!official) continue;

        const l1Data = await readCandleFile(stock.symbol, market);
        if (!l1Data || l1Data.lastDate !== lastTradingDate) continue;
        const lastBar = l1Data.candles[l1Data.candles.length - 1];
        if (!lastBar) continue;
        checked++;

        const diffAbs = Math.abs(lastBar.close - official.close);
        const diffPct = diffAbs / official.close;
        if (diffAbs > 1 || diffPct > 0.005) {
          await saveLocalCandles(stock.symbol, market, [{ date: lastTradingDate, ...official }]);
          repaired++;
          if (samples.length < 5) {
            samples.push(`${stock.symbol}: L1=${lastBar.close} → TWSE=${official.close} (${(diffPct * 100).toFixed(2)}%)`);
          }
        }
      }
      twseAudit = { checked, repaired, samples };
      if (repaired > 0) {
        console.warn(
          `[download-candles] TW: ★ TWSE 交叉稽核修復 ${repaired}/${checked} 支偏差股票`
        );
        for (const s of samples) console.warn(`  ${s}`);
      } else {
        console.info(`[download-candles] TW: TWSE 交叉稽核通過 ${checked} 支全部一致`);
      }
    }

    // ── 最終守護：TPEx OpenAPI 全量交叉稽核 + 自動修復（TW 上櫃 .TWO 專用）──
    // 跟 twseAudit 平行：對所有有 TPEx 官方資料的 .TWO 股票，比對 L1 vs 官方，偏差 > 0.5% 自動覆寫
    let tpexAudit: { checked: number; repaired: number; samples: string[] } | undefined;
    if (market === 'TW' && tpexMap) {
      let checked = 0, repaired = 0;
      const samples: string[] = [];
      for (const stock of stocks) {
        if (!stock.symbol.endsWith('.TWO')) continue;
        const code = stock.symbol.replace(/\.TWO$/i, '');
        const official = tpexMap.get(code);
        if (!official) continue;

        const l1Data = await readCandleFile(stock.symbol, market);
        if (!l1Data || l1Data.lastDate !== lastTradingDate) continue;
        const lastBar = l1Data.candles[l1Data.candles.length - 1];
        if (!lastBar) continue;
        checked++;

        const diffAbs = Math.abs(lastBar.close - official.close);
        const diffPct = diffAbs / official.close;
        if (diffAbs > 1 || diffPct > 0.005) {
          await saveLocalCandles(stock.symbol, market, [{ date: lastTradingDate, ...official }]);
          repaired++;
          if (samples.length < 5) {
            samples.push(`${stock.symbol}: L1=${lastBar.close} → TPEx=${official.close} (${(diffPct * 100).toFixed(2)}%)`);
          }
        }
      }
      tpexAudit = { checked, repaired, samples };
      if (repaired > 0) {
        console.warn(
          `[download-candles] TW: ★ TPEx 交叉稽核修復 ${repaired}/${checked} 支偏差上櫃股票`
        );
        for (const s of samples) console.warn(`  ${s}`);
      } else {
        console.info(`[download-candles] TW: TPEx 交叉稽核通過 ${checked} 支全部一致`);
      }
    }

    // ── L1 抽查（Yahoo 交叉核驗 — 第三道防線） ──
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
      twseInjected,
      tpexInjected,
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
      twseAudit,
      tpexAudit,
      spotCheck: spotCheck ? { passed: spotCheck.passed, failed: spotCheck.failed, suspicious: spotCheck.suspicious } : undefined,
    });
  } catch (err) {
    console.error(`[download-candles] ${market}: 錯誤`, err);
    return apiError(String(err));
  }
}
