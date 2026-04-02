/**
 * 訊號交易回測 API
 * 用歷史分鐘數據跑訊號引擎，模擬按訊號買賣，統計勝率損益
 *
 * GET /api/daytrade/signal-backtest?symbol=2330&days=10&timeframe=5m&capital=1000000
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { computeIntradayIndicators } from '@/lib/daytrade/IntradayIndicators';
import { IntradaySignalEngine } from '@/lib/daytrade/IntradaySignalEngine';
import type { IntradayCandle, IntradayCandleWithIndicators, IntradayTimeframe, IntradaySignal } from '@/lib/daytrade/types';
import { unixToTW } from '@/lib/timezone';

// ── Types ────────────────────────────────────────────────────────────────────

interface DayResult {
  date: string;
  trades: TradeRecord[];
  totalPnL: number;
  returnPct: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  signalCount: number;
  buySignals: number;
  sellSignals: number;
}

interface TradeRecord {
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  shares: number;
  pnl: number;
  returnPct: number;
  holdBars: number;
  entrySignal: string;
  exitReason: string;
}

interface BacktestResult {
  symbol: string;
  stockName: string;
  timeframe: string;
  daysCount: number;
  initialCapital: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  totalPnL: number;
  totalReturnPct: number;
  avgTradeReturn: number;
  medianTradeReturn: number;
  maxWin: number;
  maxLoss: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  sharpeApprox: number;
  avgTradesPerDay: number;
  bestDay: { date: string; pnl: number; returnPct: number } | null;
  worstDay: { date: string; pnl: number; returnPct: number } | null;
  dailyResults: DayResult[];
  allTrades: TradeRecord[];
}

// ── Yahoo Finance fetch ──────────────────────────────────────────────────────

async function fetchYahooIntraday(
  symbol: string,
  timeframe: IntradayTimeframe,
  days: number,
): Promise<{ candles: IntradayCandle[]; name: string }> {
  // Yahoo allows different ranges based on interval
  const tfMap: Record<string, string> = {
    '1m': '1m', '3m': '5m', '5m': '5m', '15m': '15m', '30m': '30m', '60m': '60m',
  };
  const interval = tfMap[timeframe] || '5m';

  // For intraday, max range depends on interval
  // 1m: 7 days, 5m: 60 days, 15m: 60 days, 60m: 730 days
  let range: string;
  if (interval === '1m') range = `${Math.min(days, 7)}d`;
  else if (['5m', '15m', '30m'].includes(interval)) range = `${Math.min(days, 60)}d`;
  else range = `${Math.min(days, 60)}d`;

  const yahooSymbol = /^\d{4}$/.test(symbol) ? `${symbol}.TW` : symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}&includePrePost=false`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error('無法取得歷史數據');

  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result?.timestamp) throw new Error('No data from Yahoo');

  const ts = result.timestamp as number[];
  const q = result.indicators?.quote?.[0];
  const name = result.meta?.longName ?? result.meta?.shortName ?? symbol;

  const candles: IntradayCandle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (o == null || h == null || l == null || c == null) continue;

    const iso = unixToTW(ts[i]);

    candles.push({ time: iso, open: o, high: h, low: l, close: c, volume: v ?? 0, timeframe: tfMap[timeframe] as IntradayTimeframe });
  }

  return { candles, name };
}

// ── Group candles by date ────────────────────────────────────────────────────

function groupByDate(candles: IntradayCandle[]): Map<string, IntradayCandle[]> {
  const map = new Map<string, IntradayCandle[]>();
  for (const c of candles) {
    const date = c.time.split('T')[0];
    if (!map.has(date)) map.set(date, []);
    map.get(date)!.push(c);
  }
  return map;
}

// ── Simulate one day of signal-based trading ─────────────────────────────────

function simulateDay(
  dayCandles: IntradayCandleWithIndicators[],
  timeframe: IntradayTimeframe,
  capital: number,
  stopLossPct: number = -2,   // 當沖停損 -2%
  takeProfitPct: number = 3,  // 當沖停利 +3%
): DayResult {
  const engine = new IntradaySignalEngine();
  const date = dayCandles[0]?.time.split('T')[0] ?? '';
  const trades: TradeRecord[] = [];
  const allSignals: IntradaySignal[] = [];

  let inPosition = false;
  let entryPrice = 0;
  let entryTime = '';
  let entrySignal = '';
  let shares = 0;

  // Walk through each bar
  for (let i = 5; i < dayCandles.length; i++) {
    const visible = dayCandles.slice(0, i + 1);
    const signals = engine.evaluate(visible, i, timeframe);
    allSignals.push(...signals);

    const bar = dayCandles[i];
    const highScoreBuy = signals.find(s => s.type === 'BUY' && s.score >= 60);
    const highScoreSell = signals.find(s => s.type === 'SELL' && s.score >= 60);

    if (!inPosition && highScoreBuy) {
      // Enter position
      entryPrice = bar.close;
      entryTime = bar.time;
      entrySignal = highScoreBuy.label;
      shares = Math.floor((capital * 0.5) / entryPrice / 1000) * 1000 || 1000;
      inPosition = true;
    } else if (inPosition) {
      const returnPct = ((bar.close - entryPrice) / entryPrice) * 100;

      // Check stop loss
      if (returnPct <= stopLossPct) {
        trades.push({
          entryTime, entryPrice,
          exitTime: bar.time, exitPrice: bar.close,
          shares, pnl: (bar.close - entryPrice) * shares,
          returnPct, holdBars: i,
          entrySignal, exitReason: '停損',
        });
        inPosition = false;
      }
      // Check take profit
      else if (returnPct >= takeProfitPct) {
        trades.push({
          entryTime, entryPrice,
          exitTime: bar.time, exitPrice: bar.close,
          shares, pnl: (bar.close - entryPrice) * shares,
          returnPct, holdBars: i,
          entrySignal, exitReason: '停利',
        });
        inPosition = false;
      }
      // Check sell signal
      else if (highScoreSell) {
        trades.push({
          entryTime, entryPrice,
          exitTime: bar.time, exitPrice: bar.close,
          shares, pnl: (bar.close - entryPrice) * shares,
          returnPct, holdBars: i,
          entrySignal, exitReason: `訊號: ${highScoreSell.label}`,
        });
        inPosition = false;
      }
    }
  }

  // Close at end of day if still in position
  if (inPosition && dayCandles.length > 0) {
    const lastBar = dayCandles[dayCandles.length - 1];
    const returnPct = ((lastBar.close - entryPrice) / entryPrice) * 100;
    trades.push({
      entryTime, entryPrice,
      exitTime: lastBar.time, exitPrice: lastBar.close,
      shares, pnl: (lastBar.close - entryPrice) * shares,
      returnPct, holdBars: dayCandles.length,
      entrySignal, exitReason: '收盤平倉',
    });
  }

  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const winCount = trades.filter(t => t.pnl > 0).length;
  const lossCount = trades.filter(t => t.pnl <= 0).length;
  const buySignals = allSignals.filter(s => s.type === 'BUY' && s.score >= 60).length;
  const sellSignals = allSignals.filter(s => s.type === 'SELL' && s.score >= 60).length;

  return {
    date,
    trades,
    totalPnL,
    returnPct: capital > 0 ? (totalPnL / capital) * 100 : 0,
    winCount,
    lossCount,
    winRate: trades.length > 0 ? Math.round((winCount / trades.length) * 100) : 0,
    signalCount: allSignals.filter(s => s.score >= 60).length,
    buySignals,
    sellSignals,
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────

const signalBtSchema = z.object({
  symbol: z.string().default('2330'),
  days: z.string().default('10'),
  timeframe: z.string().default('5m'),
  capital: z.string().default('1000000'),
  stopLoss: z.string().default('-2'),
  takeProfit: z.string().default('3'),
});

export async function GET(req: NextRequest) {
  const parsed = signalBtSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const symbol = parsed.data.symbol;
  const days = Math.min(parseInt(parsed.data.days), 60);
  const timeframe = parsed.data.timeframe as IntradayTimeframe;
  const capital = parseInt(parsed.data.capital);
  const stopLoss = parseFloat(parsed.data.stopLoss);
  const takeProfit = parseFloat(parsed.data.takeProfit);

  try {
    // Fetch historical intraday data
    const { candles: rawCandles, name: stockName } = await fetchYahooIntraday(symbol, timeframe, days);
    if (rawCandles.length === 0) {
      return apiError('無歷史分鐘數據', 400);
    }

    // Group by date
    const dateGroups = groupByDate(rawCandles);

    // Run simulation for each day
    const dailyResults: DayResult[] = [];
    const allTrades: TradeRecord[] = [];

    for (const [, dayCandlesRaw] of dateGroups) {
      if (dayCandlesRaw.length < 10) continue; // Skip days with too few bars

      const dayCandles = computeIntradayIndicators(dayCandlesRaw);
      const result = simulateDay(dayCandles, timeframe, capital, stopLoss, takeProfit);
      dailyResults.push(result);
      allTrades.push(...result.trades);
    }

    // Aggregate statistics
    const totalTrades = allTrades.length;
    const winCount = allTrades.filter(t => t.pnl > 0).length;
    const lossCount = allTrades.filter(t => t.pnl <= 0).length;
    const returns = allTrades.map(t => t.returnPct);
    const wins = allTrades.filter(t => t.pnl > 0);
    const losses = allTrades.filter(t => t.pnl <= 0);

    const totalPnL = allTrades.reduce((s, t) => s + t.pnl, 0);
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const sortedReturns = [...returns].sort((a, b) => a - b);
    const medianReturn = sortedReturns.length > 0
      ? sortedReturns[Math.floor(sortedReturns.length / 2)] : 0;

    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Sharpe approximation
    const mean = avgReturn;
    const variance = returns.length > 1
      ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1) : 0;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;

    const bestDay = dailyResults.length > 0
      ? dailyResults.reduce((a, b) => a.totalPnL > b.totalPnL ? a : b) : null;
    const worstDay = dailyResults.length > 0
      ? dailyResults.reduce((a, b) => a.totalPnL < b.totalPnL ? a : b) : null;

    const result: BacktestResult = {
      symbol,
      stockName,
      timeframe,
      daysCount: dailyResults.length,
      initialCapital: capital,
      totalTrades,
      winCount,
      lossCount,
      winRate: totalTrades > 0 ? Math.round((winCount / totalTrades) * 100) : 0,
      totalPnL,
      totalReturnPct: capital > 0 ? (totalPnL / capital) * 100 : 0,
      avgTradeReturn: avgReturn,
      medianTradeReturn: medianReturn,
      maxWin: returns.length > 0 ? Math.max(...returns) : 0,
      maxLoss: returns.length > 0 ? Math.min(...returns) : 0,
      avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.returnPct, 0) / wins.length : 0,
      avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.returnPct, 0) / losses.length : 0,
      profitFactor,
      sharpeApprox: sharpe,
      avgTradesPerDay: dailyResults.length > 0 ? totalTrades / dailyResults.length : 0,
      bestDay: bestDay ? { date: bestDay.date, pnl: bestDay.totalPnL, returnPct: bestDay.returnPct } : null,
      worstDay: worstDay ? { date: worstDay.date, pnl: worstDay.totalPnL, returnPct: worstDay.returnPct } : null,
      dailyResults,
      allTrades,
    };

    return apiOk(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return apiError(msg);
  }
}
