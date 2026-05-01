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

// ── TWSE MI_INDEX 官方日收盤（上市，集合競價後才更新） ───────────────────────────

interface BulkOHLCV { open: number; high: number; low: number; close: number; volume: number; }

/**
 * 抓 TWSE MI_INDEX table 8「每日收盤行情」，一次取所有上市股票的官方 OHLCV。
 * 用來替代 L2 盤中快照，避免集合競價前的快照寫入錯誤收盤價。
 */
async function fetchTWSEBulkClose(dateStr: string): Promise<Map<string, BulkOHLCV>> {
  const d = dateStr.replace(/-/g, ''); // "2026-04-29" → "20260429"
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${d}&type=ALLBUT0999`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`TWSE MI_INDEX HTTP ${res.status}`);
  const data = await res.json() as { stat: string; tables: Array<{ fields: string[]; data: string[][] }> };
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
      `TWSE=${twseMap?.size ?? 0}，L2=${l2Map?.size ?? 0}`
    );

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async ({ symbol }) => {
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

          // ── 優先路徑 2：L2 快照（上櫃 TWO / CN，或 TWSE 無此股）──
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

          // ── 全量 API 下載（L1 缺失、太舊、或兩個快照都無此股）──
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
    console.info(
      `[download-candles] ${market}: 完成 — ${succeeded} API下載, ` +
      `${twseInjected} TWSE注入, ${l2Injected} L2注入, ${skipped} 跳過, ${failed} 失敗, ${duration}s`
    );

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
      twseInjected,
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
