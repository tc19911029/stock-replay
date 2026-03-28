import { NextRequest, NextResponse } from 'next/server';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions, detectTrend, detectTrendPosition } from '@/lib/analysis/trendAnalysis';
import { computeSurgeScore } from '@/lib/analysis/surgeScore';
import { ruleEngine } from '@/lib/rules/ruleEngine';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';
import { getTWChineseName, getCNChineseName } from '@/lib/datasource/TWSENames';

export const runtime = 'nodejs';

async function fetchCandles(symbol: string) {
  const isTwDigits = /^\d+$/.test(symbol);
  const candidates = isTwDigits ? [`${symbol}.TW`, `${symbol}.TWO`] : [symbol.toUpperCase()];

  for (const ticker of candidates) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1y&includePrePost=false`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) continue;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) continue;

    const timestamps: number[] = result.timestamp ?? [];
    const q = result.indicators.quote[0];
    const candles = timestamps.map((ts, i) => {
      const o = q.open[i]; const h = q.high[i]; const l = q.low[i]; const c = q.close[i];
      if (o == null || h == null || l == null || c == null || isNaN(o)) return null;
      return { date: new Date(ts * 1000).toISOString().split('T')[0], open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +c.toFixed(2), volume: q.volume[i] ?? 0 };
    }).filter(Boolean) as { date: string; open: number; high: number; low: number; close: number; volume: number }[];

    const meta = result.meta;
    return { candles, name: meta.longName ?? meta.shortName ?? ticker, ticker };
  }
  return null;
}

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol') ?? '';
  const strategyId = req.nextUrl.searchParams.get('strategyId') ?? undefined;
  if (!symbol) return NextResponse.json({ error: '缺少 symbol' }, { status: 400 });

  const thresholds = resolveThresholds({ strategyId });

  try {
    const data = await fetchCandles(symbol);
    if (!data) return NextResponse.json({ error: '找不到股票資料' }, { status: 404 });

    const allCandles = computeIndicators(data.candles);
    if (allCandles.length < 30) return NextResponse.json({ error: '資料不足' }, { status: 400 });

    const lastIdx = allCandles.length - 1;
    const last = allCandles[lastIdx];
    const prev = allCandles[lastIdx - 1];
    const changePercent = prev?.close > 0 ? +((last.close - prev.close) / prev.close * 100).toFixed(2) : 0;

    const sixConditions = evaluateSixConditions(allCandles, lastIdx, thresholds);
    const trend = detectTrend(allCandles, lastIdx);
    const position = detectTrendPosition(allCandles, lastIdx);
    const signals = ruleEngine.evaluate(allCandles, lastIdx).filter(s => s.type !== 'WATCH');

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
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
