import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { dataProvider } from '@/lib/datasource/MultiMarketProvider';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { evaluateSixConditions, detectTrendPosition } from '@/lib/analysis/trendAnalysis';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';
import { evaluateHighWinRateEntry } from '@/lib/analysis/highWinRateEntry';
import { evaluateWinnerPatterns } from '@/lib/rules/winnerPatternRules';

const querySchema = z.object({
  symbol: z.string().min(1),
  period: z.string().default('2y'),
  strategyId: z.string().optional(),
  minScore: z.string().optional(),
});

export interface SignalDate {
  date: string;
  score: number;
  close: number;
  position: string;
  d1Return: number | null;
  d5Return: number | null;
  d10Return: number | null;
  d20Return: number | null;
  maxGain5: number | null;
  maxLoss5: number | null;
  maxGain20: number | null;
  maxLoss20: number | null;
  highWinRateTypes?: string[];
  winnerBullish?: string[];
  winnerBearish?: string[];
}

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { symbol, period, strategyId } = parsed.data;
  const thresholds = resolveThresholds({ strategyId });
  const minScore = parseInt(parsed.data.minScore ?? String(thresholds.minScore));

  try {
    // 優先讀 L1（與 /api/stock?local=1、/api/watchlist/conditions 同源），帶 .TW/.TWO 雙 fallback 避免 6187 類上櫃股繞外部 API
    const pureCode = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const isTw = /^\d+$/.test(symbol) || /\.(TW|TWO)$/i.test(symbol);
    const isCn = /\.(SS|SZ)$/i.test(symbol);
    let candles: Awaited<ReturnType<typeof loadLocalCandles>> = null;
    if (isTw) {
      const list = /\.TWO$/i.test(symbol)
        ? [`${pureCode}.TWO`, `${pureCode}.TW`]
        : [`${pureCode}.TW`, `${pureCode}.TWO`];
      for (const t of list) {
        candles = await loadLocalCandles(t, 'TW');
        if (candles && candles.length > 0) break;
      }
    } else if (isCn) {
      // CN SS/SZ 獨立代碼空間，不加 cross-fallback
      candles = await loadLocalCandles(symbol.toUpperCase(), 'CN');
    }
    // L1 沒命中才退到外部 API
    if (!candles || candles.length === 0) {
      candles = await dataProvider.getHistoricalCandles(symbol, period);
    }
    if (!candles || candles.length < 30) {
      return apiError('資料不足', 404);
    }

    const signals: SignalDate[] = [];

    for (let i = 30; i < candles.length - 1; i++) {
      const six = evaluateSixConditions(candles, i, thresholds);
      if (six.totalScore < minScore) continue;

      const position = detectTrendPosition(candles, i);
      const hwre = evaluateHighWinRateEntry(candles, i);
      const wp = evaluateWinnerPatterns(candles, i);
      const entry = candles[i].close;
      const get = (offset: number) => candles[i + offset]?.close ?? null;
      const ret = (c: number | null) => c != null ? +((c - entry) / entry * 100).toFixed(2) : null;

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
        position,
        d1Return: ret(get(1)),
        d5Return: ret(get(5)),
        d10Return: ret(get(10)),
        d20Return: ret(get(20)),
        maxGain5: +maxG5.toFixed(2),
        maxLoss5: +maxL5.toFixed(2),
        maxGain20: +maxG20.toFixed(2),
        maxLoss20: +maxL20.toFixed(2),
        highWinRateTypes: hwre.types,
        winnerBullish: wp.bullishPatterns.map(p => p.name),
        winnerBearish: wp.bearishPatterns.map(p => p.name),
      });
    }

    // Overall stats
    const total = signals.length;
    const win5  = signals.filter(s => (s.d5Return ?? 0) > 0).length;
    const win20 = signals.filter(s => (s.d20Return ?? 0) > 0).length;
    const avg5  = total > 0 ? signals.reduce((s, x) => s + (x.d5Return ?? 0), 0) / total : 0;
    const avg20 = total > 0 ? signals.reduce((s, x) => s + (x.d20Return ?? 0), 0) / total : 0;

    return apiOk({
      symbol,
      signals: signals.reverse(),
      stats: { total, win5, win20, avg5, avg20 },
    });
  } catch (err: unknown) {
    console.error('[stock-signals] error:', err);
    return apiError('訊號分析暫時無法使用');
  }
}
