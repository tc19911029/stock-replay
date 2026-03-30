import { NextRequest, NextResponse } from 'next/server';
import { fetchCandlesYahoo } from '@/lib/datasource/YahooFinanceDS';
// 台股即時報價已在 YahooDataProvider 內部自動覆蓋，無需額外處理
import { evaluateSixConditions, detectTrendPosition } from '@/lib/analysis/trendAnalysis';
import { computeSurgeScore } from '@/lib/analysis/surgeScore';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';

export interface SignalDate {
  date: string;
  score: number;
  close: number;
  surgeScore: number;
  surgeGrade: string;
  position: string;
  d1Return: number | null;
  d5Return: number | null;
  d10Return: number | null;
  d20Return: number | null;
  maxGain5: number | null;
  maxLoss5: number | null;
  maxGain20: number | null;
  maxLoss20: number | null;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol') ?? '';
  const period = searchParams.get('period') ?? '2y';
  const strategyId = searchParams.get('strategyId') ?? undefined;
  const thresholds = resolveThresholds({ strategyId });
  const minScore = parseInt(searchParams.get('minScore') ?? String(thresholds.minScore));

  if (!symbol) return NextResponse.json({ error: 'Missing symbol' }, { status: 400 });

  try {
    const candles = await fetchCandlesYahoo(symbol, period, 30000);
    if (!candles || candles.length < 30) {
      return NextResponse.json({ error: '資料不足' }, { status: 404 });
    }

    const signals: SignalDate[] = [];

    for (let i = 30; i < candles.length - 1; i++) {
      const six = evaluateSixConditions(candles, i, thresholds);
      if (six.totalScore < minScore) continue;

      const surge = computeSurgeScore(candles, i);
      const position = detectTrendPosition(candles, i);
      const entry = candles[i].close;
      const get = (offset: number) => candles[i + offset]?.close ?? null;
      const ret = (c: number | null) => c != null ? +((c - entry) / entry * 100).toFixed(2) : null;

      // Max gain/loss over next 5 and 20 candles
      let maxG5 = 0, maxL5 = 0, maxG20 = 0, maxL20 = 0;
      for (let k = 1; k <= 20 && i + k < candles.length; k++) {
        const pct = (candles[i + k].close - entry) / entry * 100;
        if (k <= 5) { if (pct > maxG5) maxG5 = pct; if (pct < maxL5) maxL5 = pct; }
        if (pct > maxG20) maxG20 = pct; if (pct < maxL20) maxL20 = pct;
      }

      signals.push({
        date: candles[i].date,
        score: six.totalScore,
        close: entry,
        surgeScore: surge.totalScore,
        surgeGrade: surge.grade,
        position,
        d1Return: ret(get(1)),
        d5Return: ret(get(5)),
        d10Return: ret(get(10)),
        d20Return: ret(get(20)),
        maxGain5: +maxG5.toFixed(2),
        maxLoss5: +maxL5.toFixed(2),
        maxGain20: +maxG20.toFixed(2),
        maxLoss20: +maxL20.toFixed(2),
      });
    }

    // Aggregate stats by surgeGrade
    const gradeStats: Record<string, { n: number; d5Sum: number; d20Sum: number; maxG20Sum: number; winD5: number; winD20: number }> = {};
    for (const s of signals) {
      const g = s.surgeGrade;
      if (!gradeStats[g]) gradeStats[g] = { n: 0, d5Sum: 0, d20Sum: 0, maxG20Sum: 0, winD5: 0, winD20: 0 };
      gradeStats[g].n++;
      if (s.d5Return != null) { gradeStats[g].d5Sum += s.d5Return; if (s.d5Return > 0) gradeStats[g].winD5++; }
      if (s.d20Return != null) { gradeStats[g].d20Sum += s.d20Return; if (s.d20Return > 0) gradeStats[g].winD20++; }
      if (s.maxGain20 != null) gradeStats[g].maxG20Sum += s.maxGain20;
    }

    const surgeGradePerformance: Record<string, { count: number; avgD5: string; avgD20: string; avgMaxGain20: string; winRateD5: string; winRateD20: string }> = {};
    for (const [g, v] of Object.entries(gradeStats)) {
      surgeGradePerformance[g] = {
        count: v.n,
        avgD5: (v.d5Sum / v.n).toFixed(2),
        avgD20: (v.d20Sum / v.n).toFixed(2),
        avgMaxGain20: (v.maxG20Sum / v.n).toFixed(2),
        winRateD5: ((v.winD5 / v.n) * 100).toFixed(0) + '%',
        winRateD20: ((v.winD20 / v.n) * 100).toFixed(0) + '%',
      };
    }

    // Overall stats
    const total = signals.length;
    const win5  = signals.filter(s => (s.d5Return ?? 0) > 0).length;
    const win20 = signals.filter(s => (s.d20Return ?? 0) > 0).length;
    const avg5  = total > 0 ? signals.reduce((s, x) => s + (x.d5Return ?? 0), 0) / total : 0;
    const avg20 = total > 0 ? signals.reduce((s, x) => s + (x.d20Return ?? 0), 0) / total : 0;

    return NextResponse.json({
      symbol,
      signals: signals.reverse(),
      stats: { total, win5, win20, avg5, avg20 },
      surgeGradePerformance,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
