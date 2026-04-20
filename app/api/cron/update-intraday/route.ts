// GET /api/cron/update-intraday — 盤中即時快照自動更新 + 掃描
//
// 由 Vercel Cron 每 5 分鐘（TW）/ 2 分鐘（CN）觸發
// 1. 將全市場即時報價寫入 Layer 2 快照（單一 JSON 檔）
// 2. 合併 L1 歷史K線，跑一次 long-daily 掃描策略
// 3. 結果存入 L4（覆蓋同日 post_close，前端免改動）

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { refreshIntradaySnapshot, getLastRefreshSummary, readIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { isMarketOpen, isPostCloseWindow, getCurrentTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';

export const runtime = 'nodejs';
export const maxDuration = 120; // 提高：L2 刷新 ~5s + 掃描 ~30-60s

export async function GET(req: NextRequest) {
  // Verify Vercel cron secret
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as 'TW' | 'CN';

  // 盤中 + 盤後窗口（TW 13:31~14:30 / CN 15:01~15:30）都跑：
  // 收盤後還需要一輪來抓最終收盤資料 + 跑盤後掃描，對齊 instrumentation.ts 的條件
  if (!isMarketOpen(market) && !isPostCloseWindow(market)) {
    return apiOk({ skipped: true, reason: `${market} 非開盤時段也非盤後窗口`, market });
  }

  try {
    // ── Phase 1: 刷新 L2 快照 ──
    let snapshot = await refreshIntradaySnapshot(market);

    // ── Phase 2: 盤中掃描（僅 long-daily，精簡版）──
    const date = getCurrentTradingDay(market);
    let scanCount = -1;

    // L2 為空時：區分「交易日 API 失敗」vs「非交易日正常」
    if (snapshot.count === 0) {
      const tradingDayFlag = isTradingDay(date, market);

      if (tradingDayFlag) {
        // ★ L2 刷新失敗 → 直接用本地既存 fresh L2 跑掃描，不再發第二道重試
        // 原本這裡 wait 15s 再呼叫 refreshIntradaySnapshot 一次，但會與 IntradayCache 內部
        // 指數退避疊加變成重試風暴，觸發 mis.twse WAF 更嚴封鎖（2026-04-20 教訓）。
        // 改為：IntradayCache 自己重試一次就夠；這層只做 existing L2 fallback + age 守門。
        const existing = await readIntradaySnapshot(market, date);
        const ageMs = existing ? Date.now() - new Date(existing.updatedAt).getTime() : Infinity;
        const STALE_FALLBACK_MAX_AGE = 120 * 60 * 1000; // 120 分鐘（EastMoney/Tencent 皆掛時撐過整個盤中）

        if (existing && existing.count > 0 && ageMs < STALE_FALLBACK_MAX_AGE) {
          console.warn(
            `[cron/update-intraday] ${market} L2 刷新失敗但本地 L2 尚 fresh ` +
            `(${existing.count} 筆, age ${Math.round(ageMs / 1000)}s)，用既存 L2 跑掃描`
          );
          snapshot = existing;
          // 繼續往下走正常掃描流程（snapshot.count > 0）
        } else {
          const refreshSummary2 = getLastRefreshSummary(market);
          console.error(
            `[cron/update-intraday] ★★ ${market} L2 刷新失敗且既存 L2 無法用！` +
            `連續空 ${refreshSummary2.consecutiveEmptyCount} 次，告警: ${refreshSummary2.alertLevel}` +
            (existing ? ` (age=${Math.round(ageMs / 1000)}s 超過 120min)` : ' (本地無 L2)')
          );
          return apiOk({
            market,
            date: snapshot.date,
            count: 0,
            updatedAt: snapshot.updatedAt,
            scanCount: -1,
            scanDate: date,
            alert: true,
            alertLevel: refreshSummary2.alertLevel,
            warning: `交易日 ${date} 所有數據源失敗，非休市！連續空 ${refreshSummary2.consecutiveEmptyCount} 次`,
            dataSourceStatus: refreshSummary2.sources,
          });
        }
      } else {
        // 非交易日 → 正常跳過
        console.info(`[cron/update-intraday] ${market} ${date} 非交易日，跳過掃描`);
        const summary = getLastRefreshSummary(market);
        return apiOk({
          market,
          date: snapshot.date,
          count: 0,
          updatedAt: snapshot.updatedAt,
          scanCount: -1,
          scanDate: date,
          warning: `${date} 非交易日`,
          dataSourceStatus: summary.sources,
        });
      }
    }

    // ── Phase 2.5: 從 L2 快照建立即時報價 Map，讓 scanner 合併今日 K 棒 ──
    const realtimeQuotes = new Map<string, { open: number; high: number; low: number; close: number; volume: number; date?: string }>();
    for (const q of snapshot.quotes) {
      const code = q.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
      if (q.close > 0) {
        realtimeQuotes.set(code, {
          open: q.open, high: q.high, low: q.low,
          close: q.close, volume: q.volume,
          date: snapshot.date,
        });
      }
    }

    try {
      const { saveScanSession } = await import('@/lib/storage/scanStorage');

      if (market === 'TW') {
        const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner');
        const scanner = new TaiwanScanner();
        scanner.setRealtimeQuotes(realtimeQuotes);
        const stocks = await scanner.getStockList();
        const { results, sessionFreshness } = await scanner.scanSOP(stocks, date);

        const session = {
          id: `TW-long-daily-${date}-intraday-${Date.now()}`,
          market: 'TW' as const,
          date,
          direction: 'long' as const,
          multiTimeframeEnabled: false,
          sessionType: 'intraday' as const,
          scanTime: new Date().toISOString(),
          resultCount: results.length,
          results,
          dataFreshness: sessionFreshness,
        };
        await saveScanSession(session);
        scanCount = results.length;
      } else {
        const { ChinaScanner } = await import('@/lib/scanner/ChinaScanner');
        const scanner = new ChinaScanner();
        scanner.setRealtimeQuotes(realtimeQuotes);
        const stocks = await scanner.getStockList();
        const { results, sessionFreshness } = await scanner.scanSOP(stocks, date);

        const session = {
          id: `CN-long-daily-${date}-intraday-${Date.now()}`,
          market: 'CN' as const,
          date,
          direction: 'long' as const,
          multiTimeframeEnabled: false,
          sessionType: 'intraday' as const,
          scanTime: new Date().toISOString(),
          resultCount: results.length,
          results,
          dataFreshness: sessionFreshness,
        };
        await saveScanSession(session);
        scanCount = results.length;
      }
    } catch (scanErr) {
      // 掃描失敗不影響 L2 更新結果
      console.error(`[cron/update-intraday] ${market} 盤中掃描失敗 (non-fatal):`, scanErr);
    }

    const finalSummary = getLastRefreshSummary(market);
    return apiOk({
      market,
      date: snapshot.date,
      count: snapshot.count,
      updatedAt: snapshot.updatedAt,
      scanCount,
      scanDate: date,
      dataSourceStatus: finalSummary.sources,
    });
  } catch (err) {
    console.error(`[cron/update-intraday] ${market} error:`, err);
    return apiError(`${market} 盤中快照更新失敗: ${String(err)}`);
  }
}
