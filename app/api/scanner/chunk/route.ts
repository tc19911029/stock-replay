import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime = 'nodejs';
export const maxDuration = 120; // one chunk takes ~80s max

import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { MarketId } from '@/lib/scanner/types';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';

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

  if (stocks.length === 0) {
    return apiOk({ results: [] });
  }

  try {
    const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
    const mode = parsed.data.mode;

    let scanResult;
    if (mode === 'sop' && parsed.data.direction === 'short') {
      // V2 做空版：做空六條件 + 做空戒律
      const { candidates, marketTrend: mt } = await scanner.scanShortCandidates(stocks, asOfDate, thresholds);
      scanResult = { results: candidates, marketTrend: mt };
    } else if (mode === 'sop') {
      // V2 做多版：六條件+戒律+淘汰法
      scanResult = await scanner.scanSOP(stocks, asOfDate, thresholds, parsed.data.rankBy);
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

    const { results, marketTrend } = scanResult;
    return apiOk({ results, marketTrend, mode: parsed.data.mode });
  } catch (err) {
    console.error('[scanner/chunk] error:', err);
    return apiError('掃描服務暫時無法使用');
  }
}
