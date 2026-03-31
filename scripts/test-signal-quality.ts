/**
 * Signal Quality Backtest — 全市場訊號品質驗證
 *
 * 做法：
 * 1. 拿台股股票池（上市+上櫃）
 * 2. 隨機抽 100 支股票（跑全部太慢）
 * 3. 對每支拿 1 年 K 線
 * 4. 每天跑 rule engine + 六大條件 → 若觸發 BUY 訊號 → 模擬進場
 * 5. 隔日開盤買，持有 5 天出場
 * 6. 統計所有交易的勝率、平均報酬、profit factor
 *
 * Usage: npx tsx scripts/test-signal-quality.ts
 */
import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { fetchCandlesYahoo } from '../lib/datasource/YahooFinanceDS';
import { computeIndicators } from '../lib/indicators';
import type { CandleWithIndicators } from '../types';
import { RuleEngine } from '../lib/rules/ruleEngine';
import { evaluateSixConditions } from '../lib/analysis/trendAnalysis';
import { ZHU_V1 } from '../lib/strategy/StrategyConfig';

const SAMPLE_SIZE = 80;       // 隨機抽樣股數
const MIN_CANDLES = 120;      // 至少 120 根 K 線
const HOLD_DAYS = 5;          // 持有天數
const SLIPPAGE = 0.001;       // 滑價 0.1%
const STOP_LOSS = -0.05;      // -5% 停損
const CONCURRENCY = 8;

interface Trade {
  symbol: string;
  signalDate: string;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  exitReason: string;
  ruleIds: string[];
  sixScore: number;
}

async function backtestOneStock(
  symbol: string,
  ruleEngine: RuleEngine,
  thresholds: typeof ZHU_V1.thresholds,
): Promise<Trade[]> {
  const raw = await fetchCandlesYahoo(symbol, '1y', 8000);
  if (!raw || raw.length < MIN_CANDLES) return [];

  const candles: CandleWithIndicators[] = computeIndicators(raw);
  const trades: Trade[] = [];

  // 從第 60 根開始（需要足夠的回看期），到倒數第 HOLD_DAYS+1 根（預留出場空間）
  for (let i = 60; i < candles.length - HOLD_DAYS - 1; i++) {
    const bar = candles[i];
    const prev = candles[i - 1];

    // ── 基本條件（簡化版 Scanner 邏輯）──────────────────────────
    // 紅 K
    if (bar.close <= bar.open) continue;
    // 突破前 5 日高
    const recentHighs = candles.slice(Math.max(0, i - 5), i).map(c => c.high);
    const prev5High = Math.max(...recentHighs);
    if (bar.close < prev5High) continue;
    // 量不能太低
    if (bar.volume < 500) continue;
    // 前一天漲幅不能太大（漲停隔天不追）
    if (prev && prev.close > 0 && (bar.close - prev.close) / prev.close > 0.095) continue;

    // ── 六大條件門檻 ──────────────────────────────────────────
    const sixConds = evaluateSixConditions(candles, i, thresholds);
    if (sixConds.totalScore < 4) continue;
    // 六大條件滿分陷阱：6/6 通常已漲完
    if (sixConds.totalScore >= 6) continue;

    // ── BUY 訊號必須觸發 ──────────────────────────────────────
    const signals = ruleEngine.evaluate(candles, i);
    const buySignals = signals.filter(s => s.type === 'BUY' || s.type === 'ADD');
    if (buySignals.length === 0) continue;

    // ── 模擬進場：隔日開盤 ────────────────────────────────────
    const entryBar = candles[i + 1];
    if (!entryBar.open || entryBar.open <= 0) continue;

    // 漲停鎖死檢測
    const range = entryBar.high - entryBar.low;
    const rangeRatio = entryBar.low > 0 ? range / entryBar.low : 0;
    if (entryBar.open === entryBar.high && rangeRatio < 0.005) continue;

    const entryPrice = entryBar.open * (1 + SLIPPAGE);

    // ── 模擬出場：持有 N 天，含停損 ─────────────────────────
    let exitPrice = 0;
    let exitReason = 'holdDays';
    const stopLossPrice = entryPrice * (1 + STOP_LOSS);

    for (let d = 0; d < HOLD_DAYS; d++) {
      const idx = i + 1 + d; // 進場日 + d
      if (idx >= candles.length) break;
      const c = candles[idx];

      // 停損檢查（進場當天用 close，之後用 low）
      const isEntryDay = d === 0;
      const hitSL = isEntryDay ? c.close <= stopLossPrice : c.low <= stopLossPrice;

      if (hitSL) {
        exitPrice = isEntryDay
          ? Math.min(c.close, stopLossPrice)
          : Math.min(c.open <= stopLossPrice ? c.open * (1 - SLIPPAGE) : stopLossPrice, stopLossPrice);
        exitReason = 'stopLoss';
        break;
      }

      // 最後一天收盤出場
      if (d === HOLD_DAYS - 1) {
        exitPrice = c.close;
        exitReason = 'holdDays';
      }
    }

    if (exitPrice <= 0) continue;

    const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;

    trades.push({
      symbol,
      signalDate: bar.date,
      entryPrice: +entryPrice.toFixed(2),
      exitPrice: +exitPrice.toFixed(2),
      returnPct: +returnPct.toFixed(2),
      exitReason,
      ruleIds: buySignals.map(s => s.ruleId),
      sixScore: sixConds.totalScore,
    });

    // 進場後跳過持有期（避免重複進場）
    i += HOLD_DAYS;
  }

  return trades;
}

async function main() {
  console.log('='.repeat(80));
  console.log('📊 全市場訊號品質回測');
  console.log('='.repeat(80));

  const scanner = new TaiwanScanner();
  const stocks = await scanner.getStockList();
  console.log(`股票池: ${stocks.length} 支`);

  // 隨機抽樣
  const shuffled = [...stocks].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, SAMPLE_SIZE);
  console.log(`抽樣: ${SAMPLE_SIZE} 支`);

  const ruleEngine = new RuleEngine();
  const thresholds = ZHU_V1.thresholds;
  const allTrades: Trade[] = [];
  let processed = 0;
  let errors = 0;

  // 分批處理
  for (let i = 0; i < sample.length; i += CONCURRENCY) {
    const batch = sample.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(s => backtestOneStock(s.symbol, ruleEngine, thresholds))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        allTrades.push(...r.value);
      } else {
        errors++;
      }
      processed++;
    }
    process.stdout.write(`\r   處理中... ${processed}/${SAMPLE_SIZE} (交易: ${allTrades.length}, 錯誤: ${errors})`);
  }

  console.log(`\n\n共 ${allTrades.length} 筆交易\n`);

  if (allTrades.length === 0) {
    console.log('❌ 沒有任何交易，可能篩選條件太嚴');
    return;
  }

  // ── 彙總統計 ──────────────────────────────────────────────────────────────
  const wins = allTrades.filter(t => t.returnPct > 0);
  const losses = allTrades.filter(t => t.returnPct <= 0);
  const avgReturn = allTrades.reduce((a, t) => a + t.returnPct, 0) / allTrades.length;
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length : 0;
  const grossProfit = wins.reduce((a, t) => a + t.returnPct, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.returnPct, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : Infinity;

  const sorted = [...allTrades].map(t => t.returnPct).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const maxWin = Math.max(...sorted);
  const maxLoss = Math.min(...sorted);

  console.log('── 整體績效 ──────────────────────────────────────');
  console.log(`交易數:      ${allTrades.length}`);
  console.log(`勝率:        ${(wins.length / allTrades.length * 100).toFixed(1)}%`);
  console.log(`平均報酬:    ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(2)}%`);
  console.log(`中位數報酬:  ${median >= 0 ? '+' : ''}${median.toFixed(2)}%`);
  console.log(`平均獲利:    +${avgWin.toFixed(2)}%`);
  console.log(`平均虧損:    ${avgLoss.toFixed(2)}%`);
  console.log(`Profit Factor: ${profitFactor.toFixed(2)}`);
  console.log(`最大獲利:    +${maxWin.toFixed(2)}%`);
  console.log(`最大虧損:    ${maxLoss.toFixed(2)}%`);

  // ── 停損率 ──────────────────────────────────────────────────────────────
  const slTrades = allTrades.filter(t => t.exitReason === 'stopLoss');
  console.log(`停損率:      ${(slTrades.length / allTrades.length * 100).toFixed(1)}% (${slTrades.length}/${allTrades.length})`);

  // ── 按六大條件分組 ────────────────────────────────────────────────────
  console.log('\n── 按六大條件分數分組 ────────────────────────────');
  for (const score of [4, 5, 6]) {
    const group = allTrades.filter(t => t.sixScore === score);
    if (group.length === 0) continue;
    const gWins = group.filter(t => t.returnPct > 0).length;
    const gAvg = group.reduce((a, t) => a + t.returnPct, 0) / group.length;
    console.log(`${score}/6: ${group.length} 筆 | 勝率 ${(gWins / group.length * 100).toFixed(0)}% | 平均 ${gAvg >= 0 ? '+' : ''}${gAvg.toFixed(2)}%`);
  }

  // ── 按訊號類型分組 ────────────────────────────────────────────────────
  console.log('\n── 按觸發規則分組（前 10）────────────────────────');
  const ruleStats = new Map<string, { count: number; totalReturn: number; wins: number }>();
  for (const t of allTrades) {
    for (const ruleId of t.ruleIds) {
      const stat = ruleStats.get(ruleId) || { count: 0, totalReturn: 0, wins: 0 };
      stat.count++;
      stat.totalReturn += t.returnPct;
      if (t.returnPct > 0) stat.wins++;
      ruleStats.set(ruleId, stat);
    }
  }
  const ruleList = [...ruleStats.entries()]
    .map(([id, s]) => ({ id, ...s, avg: s.totalReturn / s.count, winRate: s.wins / s.count * 100 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  for (const r of ruleList) {
    console.log(`${r.id.padEnd(28)} | ${r.count}筆 | 勝率 ${r.winRate.toFixed(0)}% | 平均 ${r.avg >= 0 ? '+' : ''}${r.avg.toFixed(2)}%`);
  }

  // ── 月份分佈 ──────────────────────────────────────────────────────────
  console.log('\n── 按月份分佈 ────────────────────────────────────');
  const monthStats = new Map<string, { count: number; totalReturn: number; wins: number }>();
  for (const t of allTrades) {
    const month = t.signalDate.slice(0, 7);
    const stat = monthStats.get(month) || { count: 0, totalReturn: 0, wins: 0 };
    stat.count++;
    stat.totalReturn += t.returnPct;
    if (t.returnPct > 0) stat.wins++;
    monthStats.set(month, stat);
  }
  const months = [...monthStats.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [month, s] of months) {
    const avg = s.totalReturn / s.count;
    console.log(`${month} | ${String(s.count).padStart(3)}筆 | 勝率 ${(s.wins / s.count * 100).toFixed(0).padStart(2)}% | 平均 ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
  }
}

main().catch(console.error);
