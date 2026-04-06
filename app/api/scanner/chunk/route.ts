import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime = 'nodejs';
export const maxDuration = 300; // 陸股 5000 檔需要更多時間

import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { MarketId, ScanDiagnostics } from '@/lib/scanner/types';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';
import type { RealtimeQuoteForScan } from '@/lib/scanner/MarketScanner';

const scannerChunkSchema = z.object({
  market:     z.enum(['TW', 'CN']).default('TW'),
  stocks:     z.array(z.object({ symbol: z.string(), name: z.string() })).default([]),
  strategyId: z.string().optional(),
  thresholds: z.record(z.string(), z.unknown()).optional(),
  date:       z.string().optional(),
  /** 掃描模式：full=完整管線, pure=純朱家泓六大條件, sop=V2簡化版(六條件+戒律+淘汰法) */
  mode:       z.enum(['full', 'pure', 'sop']).default('full'),
  /** 排序因子（sop 模式用） */
  rankBy:     z.enum(['composite', 'surge', 'smartMoney', 'sixConditions', 'histWinRate']).default('sixConditions'),
  /** 方向：long=做多, short=做空 */
  direction:  z.enum(['long', 'short']).default('long'),
  /** 長線保護短線：多時間框架前置過濾 */
  multiTimeframeFilter: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = scannerChunkSchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }
  const market = parsed.data.market as MarketId;
  const stocks = parsed.data.stocks;
  const asOfDate = parsed.data.date || undefined;
  const thresholds = resolveThresholds({
    strategyId: parsed.data.strategyId,
    thresholds: parsed.data.thresholds as never,
  });

  // 長線保護短線：由前端開關覆蓋策略預設值
  if (parsed.data.multiTimeframeFilter) {
    thresholds.multiTimeframeFilter = true;
  }

  if (stocks.length === 0) {
    return apiOk({ results: [] });
  }

  try {
    const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
    const mode = parsed.data.mode;

    // 今日掃描（無 asOfDate）：預取全市場即時報價
    if (!asOfDate) {
      try {
        let quotes: Map<string, RealtimeQuoteForScan>;
        if (market === 'TW') {
          const { getTWSERealtime } = await import('@/lib/datasource/TWSERealtime');
          const twseMap = await getTWSERealtime();
          quotes = new Map();
          for (const [code, q] of twseMap) {
            quotes.set(code, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
          }
        } else {
          const { getEastMoneyRealtime } = await import('@/lib/datasource/EastMoneyRealtime');
          const emMap = await getEastMoneyRealtime();
          quotes = new Map();
          for (const [code, q] of emMap) {
            quotes.set(code, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
          }
        }
        if (quotes.size > 0) {
          scanner.setRealtimeQuotes(quotes);
        }
      } catch (err) {
        console.warn('[scanner/chunk] 即時報價預取失敗，使用本地數據:', err);
        // Fallback: 不設置即時報價，掃描用本地歷史數據
      }
    }

    let scanResult: { results: unknown[]; marketTrend: unknown; diagnostics?: ScanDiagnostics };
    if (mode === 'sop' && parsed.data.direction === 'short') {
      // V2 做空版：做空六條件 + 做空戒律
      const { candidates, marketTrend: mt } = await scanner.scanShortCandidates(stocks, asOfDate, thresholds);
      scanResult = { results: candidates, marketTrend: mt };
    } else if (mode === 'sop') {
      // V2 做多版：六條件+戒律+淘汰法
      scanResult = await scanner.scanSOP(stocks, asOfDate, thresholds, parsed.data.rankBy as 'sixConditions' | 'histWinRate');
    } else if (mode === 'pure' && asOfDate) {
      scanResult = await scanner.scanListAtDatePure(stocks, asOfDate, thresholds);
    } else if (mode === 'pure') {
      const today = new Date().toISOString().split('T')[0];
      scanResult = await scanner.scanListAtDatePure(stocks, today, thresholds);
    } else if (asOfDate) {
      scanResult = await scanner.scanListAtDate(stocks, asOfDate, thresholds);
    } else {
      scanResult = await scanner.scanList(stocks, thresholds);
    }

    const { results, marketTrend, diagnostics } = scanResult;
    return apiOk({ results, marketTrend, mode: parsed.data.mode, diagnostics });
  } catch (err) {
    console.error('[scanner/chunk] error:', err);
    return apiError('掃描服務暫時無法使用');
  }
}
