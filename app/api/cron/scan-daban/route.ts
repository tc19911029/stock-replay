/**
 * 打板掃描 cron
 *
 * GET /api/cron/scan-daban               → 盤後掃描（用 getLastTradingDay，15:55 CST）
 * GET /api/cron/scan-daban?type=open     → 開盤掃描（用 getCurrentTradingDay，9:33 CST）
 * GET /api/cron/scan-daban?date=YYYY-MM-DD → 手動補掃指定日期
 *
 * type=open 流程：
 *   L2（集合競價報價）→ mergeRealtimeCandle 合成今日K棒 → 打板條件檢查 → L4
 */

import { NextRequest } from 'next/server';
import { scanDabanWithPrefilter, enrichSentimentWithStrategyHealth } from '@/lib/scanner/DabanScanner';
import { saveDabanSession } from '@/lib/storage/dabanStorage';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  try {
    const { getLastTradingDay, getCurrentTradingDay } = await import('@/lib/datasource/marketHours');
    const dateParam = req.nextUrl.searchParams.get('date');
    const typeParam = req.nextUrl.searchParams.get('type'); // 'open' = 開盤掃描

    // 日期解析：手動 date > type=open（今日）> 預設盤後（昨日）
    const date = dateParam
      ?? (typeParam === 'open' ? getCurrentTradingDay('CN') : getLastTradingDay('CN'));

    if (!isTradingDay(date, 'CN')) {
      return apiOk({ skipped: true, reason: 'non-trading day', date });
    }

    let session = await scanDabanWithPrefilter(date);

    // ── 結果品質檢查：大量 null 分數 → 全量 L1 重掃 ──
    const nonYizi = session.results.filter(r => !r.isYiZiBan);
    const nullCount = nonYizi.filter(r => r.rankScore == null || r.turnover == null).length;
    if (nonYizi.length > 0 && nullCount / nonYizi.length > 0.5) {
      console.warn(`[cron/scan-daban] ⚠️ prefilter 結果品質差（${nullCount}/${nonYizi.length} null），用全量 L1 重掃`);
      const { scanDabanFromLocalCandles } = await import('@/lib/scanner/DabanScanner');
      session = await scanDabanFromLocalCandles(date);
    }

    // 加上策略自身近 N 日勝率（B 方案）
    if (session.sentiment) {
      session.sentiment = await enrichSentimentWithStrategyHealth(session.sentiment, date);
    }

    // 開盤掃描：只要有 1 支就存（開盤初期數據可能較少）；盤後掃描維持 >= 5 支門檻
    const saveThreshold = typeParam === 'open' ? 1 : 5;

    if (session.resultCount >= saveThreshold) {
      await saveDabanSession(session);
      console.log(`[cron/scan-daban] ${date} (${typeParam ?? 'close'}): ${session.resultCount} 支漲停，已儲存`);
    } else {
      console.warn(`[cron/scan-daban] ${date} (${typeParam ?? 'close'}): 僅 ${session.resultCount} 支，疑似資料不完整，不儲存`);
    }

    return apiOk({
      date,
      type: typeParam ?? 'close',
      resultCount: session.resultCount,
      sentiment: session.sentiment,
      saved: session.resultCount >= saveThreshold,
    });
  } catch (err) {
    return apiError(String(err));
  }
}
