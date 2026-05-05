/**
 * GET /api/scanner/reentry-candidates?market=TW&direction=long&lookbackDays=14
 *
 * 回傳「之前已入選掃描、後來跌破 MA5、現在又站回 MA5」的再進場候選。
 *
 * 對齊朱家泓書本：戰法 1 波浪、戰法 4 二條均線、戰法 9 續勢
 *   — 跌破 MA5 出場後，趨勢未破 + 站回 MA5 即可寬條件再進場
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { listScanDates, loadScanSession } from '@/lib/storage/scanStorage';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { evaluateReentry } from '@/lib/backtest/reentryRules';
import { ZHU_PURE_BOOK } from '@/lib/strategy/StrategyConfig';
import type { MarketId, ScanDirection, StockScanResult } from '@/lib/scanner/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  direction: z.enum(['long', 'short']).default('long'),
  lookbackDays: z.coerce.number().int().min(3).max(30).default(14),
});

export interface ReentryCandidate {
  symbol: string;
  name: string;
  /** 第一次出現在掃描的日期（最近 lookbackDays 內） */
  firstSeenDate: string;
  /** 該股票在掃描中出現過的次數 */
  scanAppearances: number;
  /** 當前股價 */
  price: number;
  /** 與 MA5 距離（%） */
  ma5Distance: number;
  /** 各檢查項通過狀態 */
  checks: {
    trendIntact: boolean;
    maReclaimed: boolean;
    volumeOk: boolean;
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { market, direction, lookbackDays } = parsed.data;

  const reentryCfg = ZHU_PURE_BOOK.thresholds.reentry;
  if (!reentryCfg?.enabled) {
    return apiOk({ market, direction, lookbackDays, candidates: [] });
  }

  try {
    // 1. 蒐集 lookbackDays 內所有掃描日期
    const dates = await listScanDates(market as MarketId, direction as ScanDirection);
    // CST 為主：UTC slice 在凌晨 00:00–08:00 CST 會回傳前一天，今日 scan 會被誤排除
    const tz = market === 'CN' ? 'Asia/Shanghai' : 'Asia/Taipei';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const cutoff = subtractDays(today, lookbackDays);
    const recentDates = dates
      .filter(d => d.date >= cutoff && d.date <= today)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (recentDates.length === 0) {
      return apiOk({ market, direction, lookbackDays, candidates: [] });
    }

    // 2. 蒐集出現過的 symbol（記錄第一次出現日期 + 出現次數）
    const seenSymbols = new Map<string, { name: string; firstSeenDate: string; appearances: number }>();
    for (const entry of recentDates) {
      const session = await loadScanSession(market as MarketId, entry.date, direction as ScanDirection);
      if (!session) continue;
      for (const r of session.results as StockScanResult[]) {
        const existing = seenSymbols.get(r.symbol);
        if (existing) {
          existing.appearances += 1;
        } else {
          seenSymbols.set(r.symbol, {
            name: r.name || r.symbol,
            firstSeenDate: entry.date,
            appearances: 1,
          });
        }
      }
    }

    if (seenSymbols.size === 0) {
      return apiOk({ market, direction, lookbackDays, candidates: [] });
    }

    // 3. 對每支股票檢查再進場條件（用最新一根 K 棒）
    const candidates: ReentryCandidate[] = [];
    for (const [symbol, meta] of seenSymbols) {
      const candles = await loadLocalCandles(symbol, market as MarketId);
      if (!candles || candles.length < 60) continue;

      const lastIdx = candles.length - 1;
      const sig = evaluateReentry(candles, lastIdx, reentryCfg);
      if (!sig.triggered) continue;

      const last = candles[lastIdx];
      const ma5Distance = last.ma5 != null && last.ma5 > 0
        ? ((last.close - last.ma5) / last.ma5) * 100
        : 0;

      candidates.push({
        symbol,
        name: meta.name,
        firstSeenDate: meta.firstSeenDate,
        scanAppearances: meta.appearances,
        price: last.close,
        ma5Distance: +ma5Distance.toFixed(2),
        checks: sig.checks,
      });
    }

    // 4. 排序：MA5 距離小（剛站回）優先，其次出現次數多
    candidates.sort((a, b) => {
      if (Math.abs(a.ma5Distance - b.ma5Distance) > 0.5) {
        return a.ma5Distance - b.ma5Distance;
      }
      return b.scanAppearances - a.scanAppearances;
    });

    return apiOk({
      market,
      direction,
      lookbackDays,
      sourceDates: recentDates.length,
      sourceSymbols: seenSymbols.size,
      candidates,
    });
  } catch (err) {
    console.error('[reentry-candidates] error:', err);
    return apiError('再進場候選查詢失敗');
  }
}

function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
