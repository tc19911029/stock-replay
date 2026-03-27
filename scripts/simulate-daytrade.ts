/**
 * 當沖策略完整模擬回測
 * 模擬：按 BUY 訊號進場，用尾隨止損 or 收盤出場
 *
 * 用法: npx tsx scripts/simulate-daytrade.ts
 */

import { computeIntradayIndicators } from '../lib/daytrade/IntradayIndicators';
import { IntradaySignalEngine } from '../lib/daytrade/IntradaySignalEngine';
import { analyzeMultiTimeframe } from '../lib/daytrade/MultiTimeframeAnalyzer';
import type { IntradayCandle, IntradayCandleWithIndicators } from '../lib/daytrade/types';

const SYMBOLS = [
  '2330', '2317', '2454', '2308', '3008',
  '2382', '6770', '2303', '3711', '2881',
  '2412', '2886', '3037', '2891', '2357',
];

// 交易參數
const INITIAL_CAPITAL = 1_000_000;
const POSITION_PCT = 0.2;          // 每次用 20% 資金
const TRAILING_STOP_PCT = 0;       // 不用尾隨止損（v6: 讓利潤跑到收盤）
const MAX_LOSS_PCT = 0.015;        // 1.5% 固定止損
const COMMISSION = 0.001425 * 0.6; // 手續費(打6折)
const TAX = 0.0015;                // 當沖證交稅
const MARKET_CLOSE_HOUR = 13;
const MARKET_CLOSE_MIN = 28;       // 13:28 強制平倉（保留2分鐘緩衝）

interface Trade {
  symbol: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  shares: number;
  pnl: number;
  returnPct: number;
  exitReason: string;
  holdBars: number;
}

async function fetchCandles(symbol: string): Promise<IntradayCandle[]> {
  const twSymbol = symbol.length === 4 ? `${symbol}.TW` : symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${twSymbol}?interval=5m&range=5d&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`API error ${res.status}`);
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
    const d = new Date((ts[i] + 8 * 3600) * 1000);
    candles.push({ time: d.toISOString().slice(0, 19), open: o, high: h, low: l, close: c, volume: v ?? 0, timeframe: '5m' });
  }
  return candles;
}

function splitByDay(candles: IntradayCandleWithIndicators[]): Map<string, IntradayCandleWithIndicators[]> {
  const days = new Map<string, IntradayCandleWithIndicators[]>();
  for (const c of candles) {
    const d = c.time.split('T')[0];
    if (!days.has(d)) days.set(d, []);
    days.get(d)!.push(c);
  }
  return days;
}

async function main() {
  console.log('🎯 當沖策略完整模擬回測');
  console.log(`   尾隨止損: ${TRAILING_STOP_PCT * 100}%  最大止損: ${MAX_LOSS_PCT * 100}%`);
  console.log(`   倉位: ${POSITION_PCT * 100}%  強制平倉: ${MARKET_CLOSE_HOUR}:${MARKET_CLOSE_MIN}`);
  console.log();

  const engine = new IntradaySignalEngine();
  const allTrades: Trade[] = [];

  for (const symbol of SYMBOLS) {
    try {
      process.stdout.write(`📊 ${symbol} ... `);
      const raw = await fetchCandles(symbol);
      if (raw.length < 20) { console.log('數據不足'); continue; }

      const candles = computeIntradayIndicators(raw);
      const mtf = analyzeMultiTimeframe(raw);
      const days = splitByDay(candles);

      let symbolTrades = 0;

      for (const [date, dayCandles] of days.entries()) {
        if (dayCandles.length < 10) continue;

        // Re-compute MTF for this day only
        const dayRaw = raw.filter(c => c.time.startsWith(date));
        const dayMtf = dayRaw.length > 10 ? analyzeMultiTimeframe(dayRaw) : null;

        // Debug: check all signals for this day
        const allDaySigs = engine.evaluateAll(dayCandles, '5m', dayMtf ?? undefined);
        const dayBuys = allDaySigs.filter(s => s.type === 'BUY');
        if (dayBuys.length > 0) console.log(`  [${date}] ${dayBuys.length} BUY signals found, scores: ${dayBuys.map(s => s.score).join(',')}`);

        // 逐根模擬
        let inPosition = false;
        let entryPrice = 0, entryTime = '', shares = 0, highSinceEntry = 0, entryIdx = 0;

        for (let i = 5; i < dayCandles.length; i++) {
          const curr = dayCandles[i];
          const t = curr.time.split('T')[1] ?? '';
          const h = parseInt(t.slice(0, 2));
          const m = parseInt(t.slice(3, 5));

          if (inPosition) {
            // 更新最高價
            if (curr.high > highSinceEntry) highSinceEntry = curr.high;

            let exitPrice = 0, exitReason = '';

            // 1. 尾隨止損（設為0時關閉）
            if (TRAILING_STOP_PCT > 0) {
              const trailingStop = highSinceEntry * (1 - TRAILING_STOP_PCT);
              if (curr.low <= trailingStop) {
                exitPrice = trailingStop;
                exitReason = '尾隨止損';
              }
            }

            // 2. 最大止損
            const maxStop = entryPrice * (1 - MAX_LOSS_PCT);
            if (curr.low <= maxStop) {
              exitPrice = maxStop;
              exitReason = '最大止損';
            }

            // 3. 收盤前強制平倉
            if (h >= MARKET_CLOSE_HOUR && m >= MARKET_CLOSE_MIN) {
              exitPrice = curr.close;
              exitReason = '收盤平倉';
            }

            // 4. SELL 訊號
            const signals = engine.evaluate(dayCandles, i, '5m', dayMtf ?? undefined);
            const sellSig = signals.find(s => s.type === 'SELL' && s.score >= 70);
            if (sellSig && !exitPrice) {
              exitPrice = curr.close;
              exitReason = `賣出訊號(${sellSig.label})`;
            }

            if (exitPrice > 0) {
              const buyCost = entryPrice * shares * COMMISSION;
              const sellCost = exitPrice * shares * (COMMISSION + TAX);
              const grossPnl = (exitPrice - entryPrice) * shares;
              const netPnl = grossPnl - buyCost - sellCost;
              const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100 - (COMMISSION * 2 + TAX) * 100;

              allTrades.push({
                symbol, entryTime, entryPrice,
                exitTime: curr.time, exitPrice,
                shares, pnl: Math.round(netPnl),
                returnPct: Math.round(returnPct * 100) / 100,
                exitReason,
                holdBars: i - entryIdx,
              });
              symbolTrades++;
              inPosition = false;
            }
          } else {
            // 尋找 BUY 訊號（用完整數據+當前索引）
            const signals = engine.evaluate(dayCandles, i, '5m', dayMtf ?? undefined);
            const buySig = signals.find(s => s.type === 'BUY' && s.score >= 65);

            if (buySig) {
              entryPrice = curr.close;
              entryTime = curr.time;
              shares = Math.floor((INITIAL_CAPITAL * POSITION_PCT) / entryPrice / 1000) * 1000 || 1000;
              highSinceEntry = curr.high;
              entryIdx = i;
              inPosition = true;
            }
          }
        }

        // 收盤仍有持倉（不應該，但以防萬一）
        if (inPosition) {
          const lastCandle = dayCandles[dayCandles.length - 1];
          const grossPnl = (lastCandle.close - entryPrice) * shares;
          const costs = entryPrice * shares * COMMISSION + lastCandle.close * shares * (COMMISSION + TAX);
          allTrades.push({
            symbol, entryTime, entryPrice,
            exitTime: lastCandle.time, exitPrice: lastCandle.close,
            shares, pnl: Math.round(grossPnl - costs),
            returnPct: Math.round(((lastCandle.close - entryPrice) / entryPrice * 100 - (COMMISSION * 2 + TAX) * 100) * 100) / 100,
            exitReason: '收盤強制平倉',
            holdBars: dayCandles.length - 1 - entryIdx,
          });
        }
      }

      console.log(`${symbolTrades} trades`);
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.log(`❌ ${e}`);
    }
  }

  // === 統計結果 ===
  console.log('\n' + '='.repeat(60));
  console.log('📊 完整模擬交易結果');
  console.log('='.repeat(60));

  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const avgReturn = allTrades.length > 0
    ? allTrades.reduce((s, t) => s + t.returnPct, 0) / allTrades.length : 0;
  const avgHold = allTrades.length > 0
    ? allTrades.reduce((s, t) => s + t.holdBars, 0) / allTrades.length : 0;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'N/A';

  console.log(`\n總交易次數: ${allTrades.length}`);
  console.log(`獲利次數: ${wins.length}  虧損次數: ${losses.length}`);
  console.log(`勝率: ${allTrades.length > 0 ? Math.round(wins.length / allTrades.length * 100) : 0}%`);
  console.log(`\n總損益: $${totalPnl.toLocaleString()}`);
  console.log(`報酬率: ${(totalPnl / INITIAL_CAPITAL * 100).toFixed(2)}%`);
  console.log(`平均每筆報酬: ${avgReturn.toFixed(2)}%`);
  console.log(`平均持有: ${avgHold.toFixed(1)} 根 K棒 (${(avgHold * 5).toFixed(0)} 分鐘)`);
  console.log(`\nProfit Factor: ${pf}`);
  console.log(`最大獲利: $${wins.length > 0 ? Math.max(...wins.map(t => t.pnl)).toLocaleString() : 0}`);
  console.log(`最大虧損: $${losses.length > 0 ? Math.min(...losses.map(t => t.pnl)).toLocaleString() : 0}`);

  // 按出場原因統計
  console.log('\n📋 按出場原因:');
  const byReason = new Map<string, { count: number; totalPnl: number; wins: number }>();
  for (const t of allTrades) {
    if (!byReason.has(t.exitReason)) byReason.set(t.exitReason, { count: 0, totalPnl: 0, wins: 0 });
    const r = byReason.get(t.exitReason)!;
    r.count++;
    r.totalPnl += t.pnl;
    if (t.pnl > 0) r.wins++;
  }
  for (const [reason, data] of byReason.entries()) {
    console.log(`  ${reason}: ${data.count}次 勝率${Math.round(data.wins/data.count*100)}% 總損益$${data.totalPnl.toLocaleString()}`);
  }

  // 每筆交易明細
  console.log('\n📋 交易明細:');
  for (const t of allTrades) {
    const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toLocaleString()}` : `-$${Math.abs(t.pnl).toLocaleString()}`;
    console.log(`  ${t.symbol} ${t.entryTime.split('T')[1]?.slice(0,5)}→${t.exitTime.split('T')[1]?.slice(0,5)} ${t.entryPrice}→${t.exitPrice.toFixed(1)} ${pnlStr} (${t.returnPct}%) [${t.exitReason}]`);
  }
}

main().catch(console.error);
