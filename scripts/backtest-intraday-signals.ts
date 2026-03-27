/**
 * 當沖訊號多日回測腳本
 * 用多個交易日的 5m 數據測試訊號品質
 *
 * 用法: npx tsx scripts/backtest-intraday-signals.ts
 */

import { computeIntradayIndicators } from '../lib/daytrade/IntradayIndicators';
import { IntradaySignalEngine } from '../lib/daytrade/IntradaySignalEngine';
import { analyzeMultiTimeframe } from '../lib/daytrade/MultiTimeframeAnalyzer';
import { validateSignal, aggregateValidations } from '../lib/daytrade/SignalValidator';
import type { IntradayCandle, IntradaySignal, SignalValidation } from '../lib/daytrade/types';

const SYMBOLS = [
  '2330', '2317', '2454', '2308', '3008',
  '2382', '6770', '2303', '3711', '2881',
  '2412', '2886', '3037', '2891', '2357',
];
const TIMEFRAME = '5m';
const DAYS_BACK = 5;

async function fetchCandles(symbol: string): Promise<IntradayCandle[]> {
  // Use Yahoo Finance chart API directly
  const twSymbol = symbol.length === 4 ? `${symbol}.TW` : symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${twSymbol}?interval=5m&range=${DAYS_BACK}d&includePrePost=false`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Yahoo API error ${res.status} for ${symbol}`);

  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result?.timestamp) return [];

  const ts = result.timestamp as number[];
  const q = result.indicators?.quote?.[0];
  if (!q) return [];

  const candles: IntradayCandle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;

    // Convert to TW time
    const d = new Date((ts[i] + 8 * 3600) * 1000);
    const time = d.toISOString().slice(0, 19);

    candles.push({ time, open: o, high: h, low: l, close: c, volume: v ?? 0, timeframe: TIMEFRAME as '5m' });
  }
  return candles;
}

async function main() {
  console.log(`\n🔬 當沖訊號多日回測`);
  console.log(`   股票: ${SYMBOLS.join(', ')}`);
  console.log(`   週期: ${TIMEFRAME}`);
  console.log(`   天數: ${DAYS_BACK} 天\n`);

  const engine = new IntradaySignalEngine();
  const allValidations: SignalValidation[] = [];
  let totalBuys = 0, totalSells = 0, totalRisk = 0;

  for (const symbol of SYMBOLS) {
    try {
      console.log(`📊 ${symbol} ...`);
      const rawCandles = await fetchCandles(symbol);
      if (rawCandles.length < 20) { console.log(`   ⚠ 數據不足 (${rawCandles.length}根), 跳過`); continue; }

      const candles = computeIntradayIndicators(rawCandles);
      const mtf = analyzeMultiTimeframe(rawCandles);

      // Run all signals
      const signals = engine.evaluateAll(candles, TIMEFRAME as '5m', mtf);
      const buys = signals.filter(s => s.type === 'BUY');
      const sells = signals.filter(s => s.type === 'SELL');
      const risks = signals.filter(s => s.type === 'RISK');

      totalBuys += buys.length;
      totalSells += sells.length;
      totalRisk += risks.length;

      // Validate each signal
      for (const signal of signals) {
        const idx = candles.findIndex(c => c.time === signal.triggeredAt);
        if (idx < 0) continue;
        allValidations.push(validateSignal(signal, candles, idx));
      }

      console.log(`   📈 ${buys.length} BUY, ${sells.length} SELL, ${risks.length} RISK`);
      await new Promise(r => setTimeout(r, 1000)); // rate limit
    } catch (e) {
      console.log(`   ❌ ${symbol} 失敗: ${e}`);
    }
  }

  // Aggregate stats
  const stats = aggregateValidations(allValidations);
  const buyVals = allValidations.filter(v => v.signal.type === 'BUY' || v.signal.type === 'ADD');
  const buyStats = aggregateValidations(buyVals);

  const sellVals = allValidations.filter(v => v.signal.type === 'SELL' || v.signal.type === 'REDUCE');
  const sellStats = aggregateValidations(sellVals);

  console.log('\n' + '='.repeat(60));
  console.log('📊 整體統計');
  console.log('='.repeat(60));
  console.log(`總訊號: ${stats.totalSignals}`);
  console.log(`  BUY: ${totalBuys}  SELL: ${totalSells}  RISK: ${totalRisk}`);

  console.log('\n📈 BUY 訊號（核心指標）:');
  console.log(`  數量: ${buyVals.length}`);
  console.log(`  勝率: ${buyStats.accuracyRate}%`);
  console.log(`  3根均報酬: ${buyStats.avgReturn3Bar}%`);
  console.log(`  5根均報酬: ${buyStats.avgReturn5Bar}%`);
  console.log(`  10根均報酬: ${buyStats.avgReturn10Bar}%`);
  console.log(`  平均MFE: +${buyStats.avgMFE}%`);
  console.log(`  平均MAE: -${buyStats.avgMAE}%`);
  console.log(`  Profit Factor: ${buyStats.profitFactor ?? 'N/A'}`);
  console.log(`  中位數: ${buyStats.medianReturn ?? 'N/A'}%`);
  console.log(`  停損率: ${buyStats.stopLossRate}%  停利率: ${buyStats.targetHitRate}%`);

  console.log('\n📉 SELL 訊號:');
  console.log(`  數量: ${sellVals.length}`);
  console.log(`  準確率（之後跌）: ${sellStats.accuracyRate}%`);
  console.log(`  5根均報酬: ${sellStats.avgReturn5Bar}%（負值=確實跌了=賣對了）`);

  console.log('\n📋 按規則分析:');
  const byRule = new Map<string, { wins: number; total: number; returns: number[] }>();
  for (const v of allValidations) {
    const key = v.signal.label ?? v.signal.ruleId;
    if (!byRule.has(key)) byRule.set(key, { wins: 0, total: 0, returns: [] });
    const r = byRule.get(key)!;
    r.total++;
    if (v.wasAccurate) r.wins++;
    if (v.forwardReturns.bars5 != null) r.returns.push(v.forwardReturns.bars5);
  }
  for (const [rule, data] of byRule.entries()) {
    const avgRet = data.returns.length > 0
      ? (data.returns.reduce((a, b) => a + b, 0) / data.returns.length).toFixed(2)
      : 'N/A';
    console.log(`  ${rule}: ${data.wins}/${data.total} (${Math.round(data.wins/data.total*100)}%) avg5=${avgRet}%`);
  }

  console.log('\n' + '='.repeat(60));
}

main().catch(console.error);
