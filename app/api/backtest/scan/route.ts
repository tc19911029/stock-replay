import { NextRequest } from 'next/server';
import { z } from 'zod';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner }  from '@/lib/scanner/ChinaScanner';
import { MarketId }      from '@/lib/scanner/types';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

const backtestScanSchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date:   z.string(),
  stocks: z.array(z.object({ symbol: z.string(), name: z.string() })).default([]),
  /** 掃描模式：full=完整管線, pure=純朱家泓, compare=A/B比較 */
  mode:   z.enum(['full', 'pure', 'compare']).default('full'),
});

export const runtime    = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/backtest/scan
 * Body: { market, date, stocks, mode? }
 *
 * mode=full:    用完整管線（所有 60 個規則）
 * mode=pure:    用純朱家泓管線（只有核心 14 條）
 * mode=compare: 同時跑兩套，返回 A/B 比較結果
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = backtestScanSchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }
  const { market, date, stocks, mode } = parsed.data;
  const marketId = market as MarketId;

  if (!date || stocks.length === 0) {
    return apiOk({ results: [] });
  }

  if (date > new Date().toISOString().split('T')[0]) {
    return apiError('不能選未來日期', 400);
  }

  try {
    const scanner = marketId === 'CN' ? new ChinaScanner() : new TaiwanScanner();

    if (mode === 'compare') {
      // A/B 比較：同時跑 full 和 pure
      const [fullResult, pureResult] = await Promise.all([
        scanner.scanListAtDate(stocks, date),
        scanner.scanListAtDatePure(stocks, date),
      ]);

      const comparison = {
        fullSignalCount: fullResult.results.length,
        pureSignalCount: pureResult.results.length,
        // 純模式多選了多少股（或少選了多少）
        signalDiff: pureResult.results.length - fullResult.results.length,
        // full 有但 pure 沒有的（被額外規則篩掉的）
        onlyInFull: fullResult.results
          .filter(f => !pureResult.results.some(p => p.symbol === f.symbol))
          .map(r => ({ symbol: r.symbol, name: r.name, compositeScore: (r as any).compositeScore })),
        // pure 有但 full 沒有的（被額外規則過濾掉的好股票？）
        onlyInPure: pureResult.results
          .filter(p => !fullResult.results.some(f => f.symbol === p.symbol))
          .map(r => ({ symbol: r.symbol, name: r.name, sixScore: r.sixConditionsScore })),
        // 兩邊都有的
        overlap: fullResult.results
          .filter(f => pureResult.results.some(p => p.symbol === f.symbol))
          .map(r => ({ symbol: r.symbol, name: r.name })),
      };

      return apiOk({
        full: { results: fullResult.results, marketTrend: fullResult.marketTrend },
        pure: { results: pureResult.results, marketTrend: pureResult.marketTrend },
        comparison,
      });
    }

    if (mode === 'pure') {
      const { results, marketTrend } = await scanner.scanListAtDatePure(stocks, date);
      return apiOk({ results, marketTrend, mode: 'pure' });
    }

    // Default: full
    const { results, marketTrend } = await scanner.scanListAtDate(stocks, date);
    return apiOk({ results, marketTrend });
  } catch (err) {
    console.error('[backtest/scan] error:', err);
    return apiError('回測服務暫時無法使用');
  }
}
