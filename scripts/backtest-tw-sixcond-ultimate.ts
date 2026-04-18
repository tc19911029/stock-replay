/**
 * 台股六條件全因子回測 — 80種組合找最佳方案
 *
 * 10 排序因子 × 4 成交額門檻 × 2 MTF開關 = 80 種組合
 *
 * 規則：
 *   - 每天掃描六條件≥5分的股票，排名第1的隔天開盤買進
 *   - 手上有股票時不買新的（一次只持1支）
 *   - 賣出用朱老師動態出場（止損-5% + MA5 + K線信號 + KD死叉 + 60天安全網）
 *   - 初始資金100萬
 *
 * Usage: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-tw-sixcond-ultimate.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { evaluateHighWinRateEntry } from '@/lib/analysis/highWinRateEntry';
import { evaluateMultiTimeframe } from '@/lib/analysis/multiTimeframeFilter';
import type { CandleWithIndicators } from '@/types';
import { BASE_THRESHOLDS } from '@/lib/strategy/StrategyConfig';

// ── 全域參數 ──────────────────────────────────────────────────────────────────

const BACKTEST_START  = '2026-01-01';
const BACKTEST_END    = '2026-04-16';
const INITIAL_CAPITAL = 1_000_000;
const TW_COST_PCT     = (0.001425 * 0.6 * 2 + 0.003) * 100; // ≈0.471%
const SLIPPAGE_PCT    = 0.001;
const MTF_THRESHOLDS  = { ...BASE_THRESHOLDS, multiTimeframeFilter: true };

// ── 型別 ──────────────────────────────────────────────────────────────────────

interface StockData {
  name: string;
  candles: CandleWithIndicators[];
}

interface CandFeatures {
  symbol: string;
  name: string;
  idx: number;
  candles: CandleWithIndicators[];
  entryPrice: number;
  changePercent: number;
  totalScore: number;
  volumeRatio: number;
  bodyPct: number;
  deviation: number;
  mom5: number;
  turnover: number;
  highWinRateScore: number;
  mtfScore: number;
  rankScore: number;
}

interface Trade {
  no: number;
  entryDate: string;
  exitDate: string;
  symbol: string;
  name: string;
  score: number;
  changePercent: number;
  entryPrice: number;
  exitPrice: number;
  netPct: number;
  pnl: number;
  capitalAfter: number;
  exitReason: string;
  holdDays: number;
}

interface RankDef {
  name: string;
  fn: (f: CandFeatures) => number;
}

// ── 排序因子（10種）──────────────────────────────────────────────────────────

const RANK_DEFS: RankDef[] = [
  { name: '六條件總分+漲幅',   fn: f => f.totalScore * 10 + f.changePercent },
  { name: '日漲幅優先',        fn: f => f.changePercent },
  { name: '量比優先',          fn: f => Math.min(f.volumeRatio, 5) * 2 + f.changePercent / 10 },
  { name: 'K棒實體大小',       fn: f => f.bodyPct * 100 + f.changePercent / 10 },
  { name: 'MA20乖離率低',      fn: f => -f.deviation * 100 + f.changePercent / 10 },
  { name: '5日動能',           fn: f => f.mom5 + f.changePercent / 10 },
  { name: '成交額優先',        fn: f => Math.log10(Math.max(f.turnover, 1)) },
  { name: '綜合因子',          fn: f => Math.min(f.volumeRatio, 5) / 5 + Math.max(0, f.mom5) / 20 + Math.min(f.bodyPct * 100, 10) / 10 + f.changePercent / 10 },
  { name: '高勝率進場位置',    fn: f => f.highWinRateScore + f.changePercent / 10 },
];

// ── 出場參數（S1 出場策略）────────────────────────────────────────────────────
// S1：止損-5% + 曾漲超10%後跌破MA5 + 附屬條件（頭頭低/大量長黑/強覆蓋/KD死叉）

const SL_PCT            = -5;   // 固定止損
const PROFIT_GATE_PCT   = 10;   // 啟動MA5保護的獲利門檻
const MAX_HOLD          = 60;

// ── 資料載入 ──────────────────────────────────────────────────────────────────

function loadTWStocks(): Map<string, StockData> {
  const stocks = new Map<string, StockData>();
  const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
  if (!fs.existsSync(dir)) {
    console.error('  TW candles 目錄不存在：' + dir);
    return stocks;
  }
  process.stdout.write('  讀取TW K線...');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const c: CandleWithIndicators[] = Array.isArray(raw) ? raw : raw.candles ?? raw;
      if (!c || c.length < 60) continue;
      const sym = f.replace('.json', '');
      const nm = (raw as { name?: string }).name ?? sym;
      stocks.set(sym, { name: nm, candles: computeIndicators(c) });
    } catch { /* 略 */ }
  }
  console.log(` ${stocks.size} 支`);
  return stocks;
}

// ── 輔助 ──────────────────────────────────────────────────────────────────────

function getTradingDays(candles: CandleWithIndicators[]): string[] {
  return candles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);
}

function getAvgTurnover(candles: CandleWithIndicators[], dateIdx: number, n = 20): number {
  let total = 0;
  let cnt = 0;
  for (let i = Math.max(0, dateIdx - n); i < dateIdx; i++) {
    total += candles[i].volume * candles[i].close;
    cnt++;
  }
  return cnt > 0 ? total / cnt : 0;
}

function buildTopNSets(
  allStocks: Map<string, StockData>,
  tradingDays: string[],
  n: number,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const date of tradingDays) {
    const dayTurnovers: Array<{ symbol: string; avg: number }> = [];
    for (const [symbol, sd] of allStocks) {
      const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 1) continue;
      dayTurnovers.push({ symbol, avg: getAvgTurnover(sd.candles, idx) });
    }
    dayTurnovers.sort((a, b) => b.avg - a.avg);
    const topSet = new Set(dayTurnovers.slice(0, n).map(d => d.symbol));
    result.set(date, topSet);
  }
  return result;
}

// ── 建立候選 ──────────────────────────────────────────────────────────────────

function buildCandidate(
  symbol: string,
  name: string,
  candles: CandleWithIndicators[],
  idx: number,
  rankFn: RankDef,
): CandFeatures | null {
  if (idx < 60 || idx + 2 >= candles.length) return null;

  const sixResult = evaluateSixConditions(candles, idx);
  if (!sixResult.isCoreReady) return null;
  if (sixResult.totalScore < 5) return null;

  const c    = candles[idx];
  const prev = candles[idx - 1];
  const next = candles[idx + 1];

  // 隔天一字跌停開無法買入
  const nextRange = next.high - next.low;
  const nextRangePct = next.low > 0 ? nextRange / next.low * 100 : 0;
  if (next.open === next.high && nextRangePct < 0.5) return null;

  const changePercent = prev.close > 0 ? +((c.close - prev.close) / prev.close * 100).toFixed(2) : 0;
  const volumeRatio   = prev.volume > 0 ? +(c.volume / prev.volume).toFixed(2) : 1;
  const bodyPct       = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  const deviation     = sixResult.position.deviation ?? 0;
  const mom5          = idx >= 5 && candles[idx - 5].close > 0 ? (c.close / candles[idx - 5].close - 1) * 100 : 0;
  const turnover      = c.volume * c.close;
  const entryPrice    = +(next.open * (1 + SLIPPAGE_PCT)).toFixed(2);

  let highWinRateScore = 0;
  try {
    highWinRateScore = evaluateHighWinRateEntry(candles, idx).score;
  } catch { /* non-critical */ }

  let mtfScore = 0;
  try {
    const mtfResult = evaluateMultiTimeframe(candles.slice(0, idx + 1), MTF_THRESHOLDS);
    mtfScore = mtfResult.totalScore;
  } catch { /* non-critical */ }

  const features: CandFeatures = {
    symbol, name, idx, candles,
    entryPrice, changePercent, totalScore: sixResult.totalScore,
    volumeRatio, bodyPct, deviation, mom5, turnover,
    highWinRateScore, mtfScore, rankScore: 0,
  };
  features.rankScore = rankFn.fn(features);
  return features;
}

// ── 出場邏輯（朱老師動態出場）─────────────────────────────────────────────────

interface ExitResult {
  exitIdx: number;
  exitPrice: number;
  exitReason: string;
}

function simulateExit(
  candles: CandleWithIndicators[],
  entryIdx: number,
  entryPrice: number,
): ExitResult | null {
  let maxGain = 0; // 追蹤曾達到的最高收益率(%)，一旦超過PROFIT_GATE_PCT就永久啟動MA5保護

  for (let d = 0; d <= MAX_HOLD; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) break;
    const c    = candles[fi];
    const prev = fi > 0 ? candles[fi - 1] : null;

    const lowRet   = entryPrice > 0 ? (c.low   - entryPrice) / entryPrice * 100 : 0;
    const closeRet = entryPrice > 0 ? (c.close - entryPrice) / entryPrice * 100 : 0;

    // 更新歷史最高收益（每根K棒都更新，不可逆）
    if (closeRet > maxGain) maxGain = closeRet;

    // ① 進場日：收盤止損
    if (d === 0) {
      if (closeRet <= SL_PCT) return { exitIdx: fi, exitPrice: c.close, exitReason: `止損${SL_PCT}%（進場日）` };
      continue;
    }

    // ① 盤中低點觸及止損（固定-5%）
    if (lowRet <= SL_PCT) {
      return { exitIdx: fi, exitPrice: +(entryPrice * (1 + SL_PCT / 100)).toFixed(2), exitReason: `止損${SL_PCT}%` };
    }

    // ② 曾漲超10%後跌破MA5 → 停利保護（S1核心）
    if (maxGain >= PROFIT_GATE_PCT && c.ma5 && c.close < c.ma5) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '漲超10%後跌破MA5' };
    }

    // ③-a 跌破前日K線最低點
    if (prev && c.close < prev.low) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '跌破前日低點' };
    }

    // 量比計算
    const vols5 = candles.slice(Math.max(0, fi - 5), fi).map(x => x.volume).filter(v => v > 0);
    const avgVol5 = vols5.length > 0 ? vols5.reduce((a, b) => a + b, 0) / vols5.length : 0;
    const volRatio = avgVol5 > 0 ? c.volume / avgVol5 : 0;

    const body        = Math.abs(c.close - c.open);
    const upperShadow = c.high - Math.max(c.close, c.open);

    // ③-b 高檔爆量長上影線
    if (body > 0 && upperShadow > body * 2 && volRatio > 1.5 &&
        c.ma5 != null && c.ma20 != null && c.ma5 > c.ma20) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '高檔爆量長上影' };
    }

    // ③-c 急漲後大量長黑K
    if (fi >= 3) {
      const prev3Up     = [candles[fi-1], candles[fi-2], candles[fi-3]].every(x => x.close > x.open);
      const isLongBlack = c.close < c.open && body / c.open >= 0.02;
      if (prev3Up && isLongBlack && volRatio > 1.5) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '急漲後長黑K' };
      }
    }

    // ③-d 強覆蓋
    if (prev && prev.close > prev.open && c.close < c.open) {
      const midPrice = (prev.open + prev.close) / 2;
      const kdDownTurn = c.kdK != null && prev.kdK != null && c.kdK < prev.kdK;
      if (c.close < midPrice && kdDownTurn) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '強覆蓋' };
      }
    }

    // ③-e 頭頭低
    if (fi >= 10) {
      const recentHighs: number[] = [];
      for (let i = fi - 1; i >= Math.max(1, fi - 20) && recentHighs.length < 2; i--) {
        const ci = candles[i], pi = candles[i-1], ni = candles[i+1];
        if (ci && pi && ni && ci.high > pi.high && ci.high > ni.high) {
          recentHighs.push(ci.high);
        }
      }
      if (recentHighs.length >= 2 && recentHighs[0] < recentHighs[1] && c.close < recentHighs[0]) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '頭頭低' };
      }
    }

    // ④ KD 高位死叉
    if (c.kdK != null && c.kdD != null && prev?.kdK != null && prev.kdD != null) {
      if (prev.kdK > 70 && prev.kdK >= prev.kdD && c.kdK < c.kdD) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: 'KD高位死叉' };
      }
    }

    // ⑤ 安全網
    if (d === MAX_HOLD) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: `持股${MAX_HOLD}天到期` };
    }
  }
  return null;
}

// ── 回測引擎 ──────────────────────────────────────────────────────────────────

interface RunResult {
  trades: Trade[];
  finalCapital: number;
  maxDD: number;
}

function runBacktest(
  allStocks: Map<string, StockData>,
  tradingDays: string[],
  rankDef: RankDef,
  options: {
    topNSets?: Map<string, Set<string>>;
    mtfFilter?: boolean;
  } = {},
): RunResult {
  const trades: Trade[] = [];
  let holdingUntilTradingDayIdx = -1;
  let capital = INITIAL_CAPITAL;
  let peak    = INITIAL_CAPITAL;
  let maxDD   = 0;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    // 一次只持1支：還在持股期間就跳過
    if (dayIdx <= holdingUntilTradingDayIdx) continue;

    const date = tradingDays[dayIdx];
    const topNSet = options.topNSets?.get(date);

    const cands: CandFeatures[] = [];
    for (const [symbol, sd] of allStocks) {
      if (topNSet && !topNSet.has(symbol)) continue;
      const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 0) continue;
      const cand = buildCandidate(symbol, sd.name, sd.candles, idx, rankDef);
      if (cand) cands.push(cand);
    }

    // MTF 過濾
    const filtered = options.mtfFilter ? cands.filter(c => c.mtfScore >= 3) : cands;
    if (filtered.length === 0) continue;

    // 排名第1買進
    filtered.sort((a, b) => b.rankScore - a.rankScore);
    const picked = filtered[0];
    const entryDayIdx = picked.idx + 1;

    const exitResult = simulateExit(picked.candles, entryDayIdx, picked.entryPrice);
    if (!exitResult) continue;

    const { exitIdx, exitPrice, exitReason } = exitResult;
    const grossPct = picked.entryPrice > 0 ? (exitPrice - picked.entryPrice) / picked.entryPrice * 100 : 0;
    const netPct   = +(grossPct - TW_COST_PCT).toFixed(3);
    const pnl      = Math.round(capital * netPct / 100);
    capital += pnl;

    const entryDate = picked.candles[entryDayIdx]?.date?.slice(0, 10) ?? '';
    const exitDate  = picked.candles[exitIdx]?.date?.slice(0, 10) ?? '';
    const holdDays  = exitIdx - entryDayIdx;

    const edi = tradingDays.indexOf(exitDate);
    holdingUntilTradingDayIdx = edi >= 0 ? edi : dayIdx + (exitIdx - picked.idx);

    if (capital > peak) peak = capital;
    const dd = peak > 0 ? (peak - capital) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;

    trades.push({
      no: trades.length + 1,
      entryDate, exitDate,
      symbol: picked.symbol, name: picked.name,
      score: picked.totalScore,
      changePercent: picked.changePercent,
      entryPrice: picked.entryPrice, exitPrice, netPct, pnl,
      capitalAfter: capital,
      exitReason, holdDays,
    });
  }

  return { trades, finalCapital: capital, maxDD };
}

// ── 統計 ──────────────────────────────────────────────────────────────────────

interface ComboResult {
  rank: number;
  factor: string;
  filter: string;
  mtf: string;
  totalReturn: number;
  winRate: number;
  tradeCount: number;
  maxDD: number;
  avgHoldDays: number;
  finalCapital: number;
  avgWin: number;
  avgLoss: number;
  maxWinStreak: number;
  maxLossStreak: number;
}

function calcComboResult(
  factor: string,
  filter: string,
  mtf: string,
  result: RunResult,
): ComboResult {
  const { trades, finalCapital, maxDD } = result;
  const count = trades.length;
  if (count === 0) {
    return {
      rank: 0, factor, filter, mtf,
      totalReturn: 0, winRate: 0, tradeCount: 0, maxDD: 0,
      avgHoldDays: 0, finalCapital, avgWin: 0, avgLoss: 0,
      maxWinStreak: 0, maxLossStreak: 0,
    };
  }

  const wins   = trades.filter(t => t.netPct > 0);
  const losses = trades.filter(t => t.netPct <= 0);
  const avgWin  = wins.length   > 0 ? wins.reduce((s, t) => s + t.netPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;
  const avgHold = trades.reduce((s, t) => s + t.holdDays, 0) / count;

  let mxW = 0, mxL = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.netPct > 0) { cw++; cl = 0; mxW = Math.max(mxW, cw); }
    else { cl++; cw = 0; mxL = Math.max(mxL, cl); }
  }

  return {
    rank: 0, factor, filter, mtf,
    totalReturn: (finalCapital / INITIAL_CAPITAL - 1) * 100,
    winRate: wins.length / count * 100,
    tradeCount: count, maxDD,
    avgHoldDays: +avgHold.toFixed(1),
    finalCapital, avgWin, avgLoss,
    maxWinStreak: mxW, maxLossStreak: mxL,
  };
}

function pct(v: number, d = 1): string {
  return (v >= 0 ? '+' : '') + v.toFixed(d) + '%';
}

// ── 主程式 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  台股六條件全因子回測 — 80種組合找最佳方案                            ║
║                                                                      ║
║  10 排序因子 × 4 成交額門檻 × 2 MTF開關 = 80 組合                    ║
║  出場：止損-5% + MA5 + K線信號 + KD死叉 + 60天安全網                 ║
║  每天只買排名第1，一次只持1支                                         ║
║  回測期間：${BACKTEST_START} ~ ${BACKTEST_END}                              ║
║  初始資金：${INITIAL_CAPITAL.toLocaleString()} 台幣                                     ║
╚══════════════════════════════════════════════════════════════════════╝
`);

  // ── 載入數據 ──
  const allStocks = loadTWStocks();

  // 找基準股取交易日
  let bench: StockData | undefined;
  for (const sym of ['0050.TW', '2330.TW', '2317.TW']) {
    bench = allStocks.get(sym);
    if (bench) break;
  }
  if (!bench) { console.error('找不到基準股'); return; }

  const tradingDays = getTradingDays(bench.candles);
  console.log(`  台股：${allStocks.size} 支，${tradingDays.length} 個交易日（${BACKTEST_START} ~ ${BACKTEST_END}）\n`);

  // ── 預計算各門檻的成交額排名 ──
  const filterConfigs: Array<{ label: string; topN: number | null }> = [
    { label: '不過濾', topN: null },
    { label: '前500',  topN: 500 },
    { label: '前300',  topN: 300 },
    { label: '前100',  topN: 100 },
  ];

  const topNMaps = new Map<number, Map<string, Set<string>>>();
  for (const fc of filterConfigs) {
    if (fc.topN != null) {
      process.stdout.write(`  計算成交額前${fc.topN}名單...`);
      topNMaps.set(fc.topN, buildTopNSets(allStocks, tradingDays, fc.topN));
      console.log(' 完成');
    }
  }

  // ── 跑 80 種組合 ──
  const allResults: ComboResult[] = [];
  let comboIdx = 0;
  const totalCombos = RANK_DEFS.length * filterConfigs.length * 2;

  console.log(`\n  開始回測 ${totalCombos} 種組合...\n`);

  for (const fc of filterConfigs) {
    for (const useMtf of [false, true]) {
      for (const rd of RANK_DEFS) {
        comboIdx++;
        const mtfLabel = useMtf ? 'MTF≥3' : '無MTF';
        process.stdout.write(`\r  [${comboIdx}/${totalCombos}] ${fc.label} | ${mtfLabel} | ${rd.name}...`.padEnd(80));

        const options: { topNSets?: Map<string, Set<string>>; mtfFilter?: boolean } = {};
        if (fc.topN != null) options.topNSets = topNMaps.get(fc.topN);
        if (useMtf) options.mtfFilter = true;

        const result = runBacktest(allStocks, tradingDays, rd, options);
        const combo = calcComboResult(rd.name, fc.label, mtfLabel, result);
        allResults.push(combo);
      }
    }
  }
  console.log(`\r  回測完成！共 ${allResults.length} 種組合${''.padEnd(50)}\n`);

  // ── 排名 ──
  allResults.sort((a, b) => b.totalReturn - a.totalReturn);
  allResults.forEach((r, i) => r.rank = i + 1);

  // ── 印 Top 20 ──
  console.log('═'.repeat(140));
  console.log('  【總報酬排行榜 Top 20】');
  console.log('═'.repeat(140));
  console.log(
    '  排名' +
    '  排序因子'.padEnd(24) +
    '門檻'.padStart(7) +
    ' MTF'.padStart(7) +
    '總報酬'.padStart(10) +
    '最終資金'.padStart(14) +
    '筆數'.padStart(6) +
    '勝率'.padStart(7) +
    '最大回撤'.padStart(9) +
    '均持天'.padStart(7) +
    '均獲利'.padStart(8) +
    '均虧損'.padStart(8) +
    '連勝'.padStart(5) +
    '連敗'.padStart(5)
  );
  console.log('  ' + '─'.repeat(138));

  for (const r of allResults.slice(0, 20)) {
    if (r.tradeCount === 0) {
      console.log(`  ${r.rank.toString().padStart(4)}  ${r.factor.padEnd(22)} ${r.filter.padStart(7)} ${r.mtf.padStart(7)}  — 無交易`);
      continue;
    }
    console.log(
      `  ${r.rank.toString().padStart(4)}` +
      `  ${r.factor.padEnd(22)}` +
      `${r.filter.padStart(7)}` +
      `${r.mtf.padStart(7)}` +
      `${pct(r.totalReturn).padStart(10)}` +
      `${r.finalCapital.toLocaleString().padStart(14)}` +
      `${r.tradeCount.toString().padStart(6)}` +
      `${(r.winRate.toFixed(1) + '%').padStart(7)}` +
      `${(r.maxDD.toFixed(1) + '%').padStart(9)}` +
      `${r.avgHoldDays.toFixed(1).padStart(7)}` +
      `${pct(r.avgWin).padStart(8)}` +
      `${(r.avgLoss.toFixed(2) + '%').padStart(8)}` +
      `${r.maxWinStreak.toString().padStart(5)}` +
      `${r.maxLossStreak.toString().padStart(5)}`
    );
  }
  console.log('  ' + '─'.repeat(138));

  // ── 印 Bottom 10 ──
  console.log(`\n  【最差 10 名】`);
  console.log('  ' + '─'.repeat(138));
  for (const r of allResults.slice(-10)) {
    if (r.tradeCount === 0) {
      console.log(`  ${r.rank.toString().padStart(4)}  ${r.factor.padEnd(22)} ${r.filter.padStart(7)} ${r.mtf.padStart(7)}  — 無交易`);
      continue;
    }
    console.log(
      `  ${r.rank.toString().padStart(4)}` +
      `  ${r.factor.padEnd(22)}` +
      `${r.filter.padStart(7)}` +
      `${r.mtf.padStart(7)}` +
      `${pct(r.totalReturn).padStart(10)}` +
      `${r.finalCapital.toLocaleString().padStart(14)}` +
      `${r.tradeCount.toString().padStart(6)}` +
      `${(r.winRate.toFixed(1) + '%').padStart(7)}` +
      `${(r.maxDD.toFixed(1) + '%').padStart(9)}` +
      `${r.avgHoldDays.toFixed(1).padStart(7)}` +
      `${pct(r.avgWin).padStart(8)}` +
      `${(r.avgLoss.toFixed(2) + '%').padStart(8)}` +
      `${r.maxWinStreak.toString().padStart(5)}` +
      `${r.maxLossStreak.toString().padStart(5)}`
    );
  }

  // ── 維度分析：哪個排序因子平均最好 ──
  console.log(`\n${'═'.repeat(100)}`);
  console.log('  【排序因子平均表現】（跨所有門檻+MTF組合）');
  console.log('═'.repeat(100));

  const factorAvg = RANK_DEFS.map(rd => {
    const rows = allResults.filter(r => r.factor === rd.name);
    const avg = rows.reduce((s, r) => s + r.totalReturn, 0) / rows.length;
    const best = rows.sort((a, b) => b.totalReturn - a.totalReturn)[0];
    return { name: rd.name, avg, best };
  }).sort((a, b) => b.avg - a.avg);

  for (let i = 0; i < factorAvg.length; i++) {
    const { name, avg, best } = factorAvg[i];
    console.log(
      `  ${(i + 1).toString().padStart(2)}. ${name.padEnd(24)} 平均${pct(avg).padStart(9)} | ` +
      `最佳: ${best.filter}+${best.mtf} ${pct(best.totalReturn).padStart(9)}`
    );
  }

  // ── 維度分析：哪個門檻+MTF組合平均最好 ──
  console.log(`\n${'═'.repeat(100)}`);
  console.log('  【門檻+MTF組合平均表現】（跨所有排序因子）');
  console.log('═'.repeat(100));

  const modeAvg: Array<{ label: string; avg: number; best: ComboResult }> = [];
  for (const fc of filterConfigs) {
    for (const useMtf of [false, true]) {
      const mtfLabel = useMtf ? 'MTF≥3' : '無MTF';
      const rows = allResults.filter(r => r.filter === fc.label && r.mtf === mtfLabel);
      const avg = rows.reduce((s, r) => s + r.totalReturn, 0) / rows.length;
      const best = [...rows].sort((a, b) => b.totalReturn - a.totalReturn)[0];
      modeAvg.push({ label: `${fc.label} + ${mtfLabel}`, avg, best });
    }
  }
  modeAvg.sort((a, b) => b.avg - a.avg);

  for (let i = 0; i < modeAvg.length; i++) {
    const { label, avg, best } = modeAvg[i];
    console.log(
      `  ${(i + 1).toString().padStart(2)}. ${label.padEnd(20)} 平均${pct(avg).padStart(9)} | ` +
      `最佳因子: ${best.factor.padEnd(20)} ${pct(best.totalReturn).padStart(9)}`
    );
  }

  // ── 最終結論 ──
  const champion = allResults[0];
  const loser    = allResults[allResults.length - 1];

  console.log(`\n${'═'.repeat(100)}`);
  console.log('  【最終結論】');
  console.log('═'.repeat(100));
  console.log(`  冠軍：${champion.factor} + ${champion.filter} + ${champion.mtf}`);
  console.log(`         總報酬 ${pct(champion.totalReturn)} | ${champion.tradeCount}筆 | 勝率${champion.winRate.toFixed(1)}% | 最大回撤${champion.maxDD.toFixed(1)}% | 均持${champion.avgHoldDays}天`);
  console.log(`         最終資金 ${champion.finalCapital.toLocaleString()} 台幣（初始100萬）`);
  console.log();
  console.log(`  末名：${loser.factor} + ${loser.filter} + ${loser.mtf}`);
  console.log(`         總報酬 ${pct(loser.totalReturn)} | ${loser.tradeCount}筆 | 勝率${loser.winRate.toFixed(1)}%`);
  console.log('═'.repeat(100));

  // ── 印第1名的逐筆交易明細 ──
  console.log(`\n  【冠軍方案逐筆交易明細】`);
  console.log('  ' + '─'.repeat(120));

  // 重跑冠軍方案取得 trades
  const champRankDef = RANK_DEFS.find(r => r.name === champion.factor)!;
  const champOptions: { topNSets?: Map<string, Set<string>>; mtfFilter?: boolean } = {};
  if (champion.filter !== '不過濾') {
    const n = parseInt(champion.filter.replace('前', ''));
    champOptions.topNSets = topNMaps.get(n);
  }
  if (champion.mtf === 'MTF≥3') champOptions.mtfFilter = true;

  const champResult = runBacktest(allStocks, tradingDays, champRankDef, champOptions);

  console.log(
    '  #'.padEnd(5) +
    '進場日'.padEnd(13) +
    '出場日'.padEnd(13) +
    '股票'.padEnd(14) +
    '進場價'.padStart(8) +
    '出場價'.padStart(8) +
    '報酬%'.padStart(9) +
    '損益'.padStart(10) +
    '持天'.padStart(5) +
    '  出場原因'
  );
  console.log('  ' + '─'.repeat(120));

  for (const t of champResult.trades) {
    console.log(
      `  ${t.no.toString().padEnd(4)}` +
      `${t.entryDate.padEnd(13)}` +
      `${t.exitDate.padEnd(13)}` +
      `${(t.symbol + ' ' + t.name).slice(0, 12).padEnd(14)}` +
      `${t.entryPrice.toFixed(1).padStart(8)}` +
      `${t.exitPrice.toFixed(1).padStart(8)}` +
      `${pct(t.netPct, 2).padStart(9)}` +
      `${t.pnl.toLocaleString().padStart(10)}` +
      `${t.holdDays.toString().padStart(5)}` +
      `  ${t.exitReason}`
    );
  }
  console.log('  ' + '─'.repeat(120));
}

main().catch(console.error);
