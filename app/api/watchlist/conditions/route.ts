import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { evaluateSixConditions, detectTrend, detectTrendPosition } from '@/lib/analysis/trendAnalysis';
import { RuleEngine, ruleEngine } from '@/lib/rules/ruleEngine';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';
import { BUILT_IN_STRATEGIES } from '@/lib/strategy/StrategyConfig';
import { getTWChineseName, getCNChineseName } from '@/lib/datasource/TWSENames';
import { dataProvider } from '@/lib/datasource/MultiMarketProvider';
import type { CandleWithIndicators } from '@/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  symbol: z.string().min(1),
  strategyId: z.string().optional(),
});

async function fetchCandles(symbol: string): Promise<{ candles: CandleWithIndicators[]; name: string; ticker: string } | null> {
  const pureCode = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const isTwDigits = /^\d+$/.test(symbol);
  const isTw = isTwDigits || /\.(TW|TWO)$/i.test(symbol);
  const isCn = /\.(SS|SZ)$/i.test(symbol);

  // Candidates 排序：先用 user 指定的後綴，再 fallback；為避免 .TW 帶後綴卡死無 fallback 的 bug
  let candidates: string[];
  if (isTw) {
    if (/\.TWO$/i.test(symbol)) candidates = [`${pureCode}.TWO`, `${pureCode}.TW`];
    else candidates = [`${pureCode}.TW`, `${pureCode}.TWO`];
  } else if (isCn) {
    // CN SS/SZ 是獨立代碼空間（000001.SS=上證指數 vs 000001.SZ=平安銀行），不加 cross-fallback
    candidates = [symbol.toUpperCase()];
  } else {
    candidates = [symbol.toUpperCase()];
  }

  // 優先讀 L1（與 /api/stock?local=1 路徑同源），避免外部 API 跟 L1 不一致
  const market: 'TW' | 'CN' | null = isTw ? 'TW' : isCn ? 'CN' : null;
  if (market) {
    const { loadLocalCandles } = await import('@/lib/datasource/LocalCandleStore');
    for (const ticker of candidates) {
      try {
        const candles = await loadLocalCandles(ticker, market);
        if (candles && candles.length > 0) {
          return { candles, name: ticker, ticker };
        }
      } catch { continue; }
    }
  }

  // L1 沒命中（少見，例如剛上市未下載）才打外部 API
  for (const ticker of candidates) {
    try {
      const candles = await dataProvider.getHistoricalCandles(ticker, '1y');
      if (candles.length > 0) {
        return { candles, name: ticker, ticker };
      }
    } catch { continue; }
  }
  return null;
}

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { symbol, strategyId } = parsed.data;

  const thresholds = resolveThresholds({ strategyId });

  try {
    const data = await fetchCandles(symbol);
    if (!data) return apiError('找不到股票資料', 404);

    const allCandles = data.candles;
    if (allCandles.length < 30) return apiError('資料不足', 400);

    const lastIdx = allCandles.length - 1;
    const last = allCandles[lastIdx];
    const prev = allCandles[lastIdx - 1];
    const changePercent = prev?.close > 0 ? +((last.close - prev.close) / prev.close * 100).toFixed(2) : 0;

    const sixConditions = evaluateSixConditions(allCandles, lastIdx, thresholds);
    const trend = detectTrend(allCandles, lastIdx);
    const position = detectTrendPosition(allCandles, lastIdx);

    // 並列買法命中（A=六條件 / B=回後買上漲 / C=盤整突破 / D=一字底 / E=缺口 / F=V反轉）
    const matchedMethods: string[] = [];
    if (sixConditions.isCoreReady) matchedMethods.push('A');
    try {
      const { detectBreakoutEntry, detectConsolidationBreakout } = await import('@/lib/analysis/breakoutEntry');
      if (detectBreakoutEntry(allCandles, lastIdx)?.isBreakout) matchedMethods.push('B');
      if (detectConsolidationBreakout(allCandles, lastIdx)?.isBreakout) matchedMethods.push('C');
    } catch { /* */ }
    try {
      const { detectStrategyE } = await import('@/lib/analysis/highWinRateEntry');
      if (detectStrategyE(allCandles, lastIdx)?.isFlatBottom) matchedMethods.push('D');
    } catch { /* */ }
    try {
      const { detectStrategyD } = await import('@/lib/analysis/gapEntry');
      if (detectStrategyD(allCandles, lastIdx)?.isGapEntry) matchedMethods.push('E');
    } catch { /* */ }
    try {
      const { detectVReversal } = await import('@/lib/analysis/vReversalDetector');
      if (detectVReversal(allCandles, lastIdx)?.isVReversal) matchedMethods.push('F');
    } catch { /* */ }
    try {
      const { detectABCBreakout } = await import('@/lib/analysis/abcBreakoutEntry');
      if (detectABCBreakout(allCandles, lastIdx)?.isABCBreakout) matchedMethods.push('G');
    } catch { /* */ }
    try {
      const { detectBlackKBreakout } = await import('@/lib/analysis/blackKBreakoutEntry');
      if (detectBlackKBreakout(allCandles, lastIdx)?.isBlackKBreakout) matchedMethods.push('H');
    } catch { /* */ }
    const sortedMatched = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].filter(m => matchedMethods.includes(m));
    // 根據策略篩選規則群組
    const strategy = strategyId ? BUILT_IN_STRATEGIES.find(s => s.id === strategyId) : undefined;
    const engine = (strategy?.ruleGroups && strategy.ruleGroups.length > 0)
      ? new RuleEngine(undefined, strategy.ruleGroups)
      : ruleEngine;
    const signals = engine.evaluate(allCandles, lastIdx).filter(s => s.type !== 'WATCH');

    // 嘗試取得中文名稱
    const code = symbol.replace(/\D/g, '');
    const cnName = await getCNChineseName(code) ?? await getTWChineseName(code);
    const displayName = cnName ?? data.name;

    return apiOk({
      symbol: data.ticker,
      name: displayName,
      price: last.close,
      changePercent,
      trend,
      position,
      sixConditions,
      matchedMethods: sortedMatched,
      hasBuySignal: signals.some(s => s.type === 'BUY' || s.type === 'ADD'),
    });
  } catch (err) {
    console.error('[watchlist/conditions] error:', err);
    return apiError('條件查詢暫時無法使用');
  }
}
