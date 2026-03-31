import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { evaluateSixConditions, detectTrend, detectTrendPosition } from '@/lib/analysis/trendAnalysis';
import { computeSurgeScore } from '@/lib/analysis/surgeScore';
import { RuleEngine, ruleEngine } from '@/lib/rules/ruleEngine';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';
import { BUILT_IN_STRATEGIES } from '@/lib/strategy/StrategyConfig';
import { getTWChineseName, getCNChineseName } from '@/lib/datasource/TWSENames';
import { yahooProvider } from '@/lib/datasource/YahooDataProvider';
import type { CandleWithIndicators } from '@/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  symbol: z.string().min(1),
  strategyId: z.string().optional(),
});

async function fetchCandles(symbol: string): Promise<{ candles: CandleWithIndicators[]; name: string; ticker: string } | null> {
  const isTwDigits = /^\d+$/.test(symbol);
  const candidates = isTwDigits ? [`${symbol}.TW`, `${symbol}.TWO`] : [symbol.toUpperCase()];

  for (const ticker of candidates) {
    try {
      const candles = await yahooProvider.getHistoricalCandles(ticker, '1y');
      if (candles.length > 0) {
        return { candles, name: ticker, ticker };
      }
    } catch { continue; }
  }
  return null;
}

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  const { symbol, strategyId } = parsed.data;

  const thresholds = resolveThresholds({ strategyId });

  try {
    const data = await fetchCandles(symbol);
    if (!data) return NextResponse.json({ error: '找不到股票資料' }, { status: 404 });

    const allCandles = data.candles;
    if (allCandles.length < 30) return NextResponse.json({ error: '資料不足' }, { status: 400 });

    const lastIdx = allCandles.length - 1;
    const last = allCandles[lastIdx];
    const prev = allCandles[lastIdx - 1];
    const changePercent = prev?.close > 0 ? +((last.close - prev.close) / prev.close * 100).toFixed(2) : 0;

    const sixConditions = evaluateSixConditions(allCandles, lastIdx, thresholds);
    const trend = detectTrend(allCandles, lastIdx);
    const position = detectTrendPosition(allCandles, lastIdx);
    // 根據策略篩選規則群組
    const strategy = strategyId ? BUILT_IN_STRATEGIES.find(s => s.id === strategyId) : undefined;
    const engine = (strategy?.ruleGroups && strategy.ruleGroups.length > 0)
      ? new RuleEngine(undefined, strategy.ruleGroups)
      : ruleEngine;
    const signals = engine.evaluate(allCandles, lastIdx).filter(s => s.type !== 'WATCH');

    const surge = computeSurgeScore(allCandles, lastIdx);

    // 嘗試取得中文名稱
    const code = symbol.replace(/\D/g, '');
    const cnName = await getCNChineseName(code) ?? await getTWChineseName(code);
    const displayName = cnName ?? data.name;

    return NextResponse.json({
      symbol: data.ticker,
      name: displayName,
      price: last.close,
      changePercent,
      trend,
      position,
      sixConditions,
      hasBuySignal: signals.some(s => s.type === 'BUY' || s.type === 'ADD'),
      surgeScore: surge.totalScore,
      surgeGrade: surge.grade,
      surgeFlags: surge.flags,
    });
  } catch (err) {
    console.error('[watchlist/conditions] error:', err);
    return NextResponse.json({ error: '條件查詢暫時無法使用' }, { status: 500 });
  }
}
