/**
 * 全因子組合批量回測
 *
 * 自動跑所有 SIXCOND 因子組合，最後輸出排行榜。
 *
 * 組合數量：
 *   市場 × topN × mtfMin × sortBy
 *   = 2 × 5 × 2 × 10 = 200 組
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-all.ts
 *
 * 可選：只跑台股
 *   MARKET=TW NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-all.ts
 */

import fs   from 'fs';
import path from 'path';
import { computeIndicators }          from '@/lib/indicators';
import { evaluateSixConditions }      from '@/lib/analysis/trendAnalysis';
import { evaluateMultiTimeframe }     from '@/lib/analysis/multiTimeframeFilter';
import { evaluateHighWinRateEntry }   from '@/lib/analysis/highWinRateEntry';
import { ruleEngine }                 from '@/lib/rules/ruleEngine';
import type { CandleWithIndicators }  from '@/types';
import { BASE_THRESHOLDS }            from '@/lib/strategy/StrategyConfig';

// ══════════════════════════════════════════════════════════════
// 全局設定
// ══════════════════════════════════════════════════════════════

const PERIOD = {
  start: process.env.PERIOD_START ?? '2025-04-16',
  end:   process.env.PERIOD_END   ?? '2026-04-16',
};
const CAPITAL        = 1_000_000;
const SLIPPAGE_PCT   = 0.001;
const TW_COST_PCT    = (0.001425 * 0.6 * 2 + 0.003) * 100;
const CN_COST_PCT    = 0.16;
const MTF_CFG        = { ...BASE_THRESHOLDS, multiTimeframeFilter: true };
const LIMIT_UP_PCT   = 9.5;
const S1_SL_PCT      = -5;
const S1_PROFIT_GATE = 10;
const S1_MAX_HOLD    = 60;

// 哪些市場要跑（可用環境變數 MARKET=TW 只跑台股）
const MARKETS_TO_RUN: ('TW' | 'CN')[] = (() => {
  const env = process.env.MARKET;
  if (env === 'TW') return ['TW'];
  if (env === 'CN') return ['CN'];
  return ['TW', 'CN'];
})();

// ══════════════════════════════════════════════════════════════
// 組合定義
// ══════════════════════════════════════════════════════════════

type SixcondSort =
  | '六條件總分' | '成交額' | '量比' | '動能' | 'K棒實體'
  | '乖離率低' | '漲幅' | '綜合因子' | '共振+高勝率' | '高勝率';

const ALL_SORT_FACTORS: SixcondSort[] = [
  '六條件總分', '成交額', '量比', '動能', 'K棒實體',
  '乖離率低', '漲幅', '綜合因子', '共振+高勝率', '高勝率',
];

const ALL_TOP_N   = [0, 200, 500];              // 0 = 全部，前200，前500
const ALL_MTF_MIN = [0, 3];                     // 0 = 不篩

interface Combo {
  market: 'TW' | 'CN';
  topN:   number;
  mtfMin: number;
  sortBy: SixcondSort;
}

function buildCombos(): Combo[] {
  const combos: Combo[] = [];
  for (const market of MARKETS_TO_RUN) {
    for (const topN of ALL_TOP_N) {
      for (const mtfMin of ALL_MTF_MIN) {
        for (const sortBy of ALL_SORT_FACTORS) {
          combos.push({ market, topN, mtfMin, sortBy });
        }
      }
    }
  }
  return combos;
}

// ══════════════════════════════════════════════════════════════
// 型別
// ══════════════════════════════════════════════════════════════

interface StockData {
  name:    string;
  candles: CandleWithIndicators[];
}

interface SixcondFeatures {
  symbol: string; name: string; idx: number; candles: CandleWithIndicators[];
  entryPrice: number; totalScore: number; changePercent: number;
  volumeRatio: number; bodyPct: number; deviation: number;
  mom5: number; turnover: number;
  resonanceScore: number; highWinRateScore: number; mtfScore: number;
  rankScore: number;
}

interface ExitResult {
  exitIdx:    number;
  exitPrice:  number;
  exitReason: string;
}

interface Trade {
  entryDate:    string;
  exitDate:     string;
  symbol:       string;
  entryPrice:   number;
  exitPrice:    number;
  netPct:       number;
  pnl:          number;
  capitalAfter: number;
  holdDays:     number;
  exitReason:   string;
}

interface ComboResult {
  combo:       Combo;
  totalReturn: number;
  tradeCount:  number;
  winRate:     number;
  maxDD:       number;
  avgHold:     number;
  finalCapital:number;
}

// ══════════════════════════════════════════════════════════════
// 排序因子
// ══════════════════════════════════════════════════════════════

const SORT_DEFS: Record<SixcondSort, (f: SixcondFeatures) => number> = {
  '六條件總分':  f => f.totalScore * 10 + f.changePercent,
  '成交額':      f => Math.log10(Math.max(f.turnover, 1)),
  '量比':        f => Math.min(f.volumeRatio, 5) * 2 + f.changePercent / 10,
  '動能':        f => f.mom5 + f.changePercent / 10,
  'K棒實體':     f => f.bodyPct * 100 + f.changePercent / 10,
  '乖離率低':    f => -f.deviation * 100 + f.changePercent / 10,
  '漲幅':        f => f.changePercent,
  '綜合因子':    f => Math.min(f.volumeRatio, 5) / 5 + Math.max(0, f.mom5) / 20
                      + Math.min(f.bodyPct * 100, 10) / 10 + f.changePercent / 10,
  '共振+高勝率': f => f.resonanceScore + f.highWinRateScore + f.changePercent / 100,
  '高勝率':      f => f.highWinRateScore + f.changePercent / 10,
};

// ══════════════════════════════════════════════════════════════
// 資料載入
// ══════════════════════════════════════════════════════════════

function loadStocks(market: 'TW' | 'CN'): Map<string, StockData> {
  const stocks = new Map<string, StockData>();

  if (market === 'TW') {
    const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
    if (!fs.existsSync(dir)) { console.error('TW candles 目錄不存在：' + dir); return stocks; }
    process.stdout.write('  讀取TW K線...');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        const c: CandleWithIndicators[] = Array.isArray(raw) ? raw : raw.candles ?? raw;
        if (!c || c.length < 60) continue;
        stocks.set(f.replace('.json', ''), {
          name:    (raw as { name?: string }).name ?? f.replace('.json', ''),
          candles: computeIndicators(c),
        });
      } catch { /* 略 */ }
    }
    console.log(` ${stocks.size} 支`);
    return stocks;
  }

  // CN：bulk cache + per-symbol 補充
  const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');
  if (fs.existsSync(cacheFile)) {
    process.stdout.write('  讀取CN bulk cache...');
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    let n = 0;
    for (const [sym, d] of Object.entries(raw.stocks as Record<string, { name: string; candles: unknown[] }>)) {
      if (!d.candles || d.candles.length < 60 || d.name.includes('ST')) continue;
      try {
        stocks.set(sym, { name: d.name, candles: computeIndicators(d.candles as CandleWithIndicators[]) });
        n++;
      } catch { /* 略 */ }
    }
    console.log(` ${n} 支`);
  }
  const perDir = path.join(process.cwd(), 'data', 'candles', 'CN');
  if (fs.existsSync(perDir)) {
    process.stdout.write('  補充CN per-symbol...');
    let u = 0;
    for (const f of fs.readdirSync(perDir).filter(f => f.endsWith('.json'))) {
      const sym = f.replace('.json', '');
      try {
        const raw2 = JSON.parse(fs.readFileSync(path.join(perDir, f), 'utf-8'));
        const c2: CandleWithIndicators[] = Array.isArray(raw2) ? raw2 : raw2.candles ?? raw2;
        if (!c2 || c2.length < 60) continue;
        const existing = stocks.get(sym);
        const lastE = existing?.candles.at(-1)?.date?.slice(0, 10) ?? '';
        const lastN = c2.at(-1)?.date?.slice(0, 10) ?? '';
        if (lastN > lastE) {
          const nm = (raw2 as { name?: string }).name ?? existing?.name ?? sym;
          if (typeof nm === 'string' && nm.includes('ST')) continue;
          stocks.set(sym, { name: nm, candles: computeIndicators(c2) });
          u++;
        }
      } catch { /* 略 */ }
    }
    console.log(` 更新 ${u} 支，共 ${stocks.size} 支`);
  }
  return stocks;
}

// ══════════════════════════════════════════════════════════════
// 前N集合快取（同市場/同日期共享）
// ══════════════════════════════════════════════════════════════

function buildTopNSet(
  allStocks: Map<string, StockData>,
  date: string,
  topN: number,
): Set<string> | null {
  if (!topN) return null;
  const list: { symbol: string; avg: number }[] = [];
  for (const [symbol, sd] of allStocks) {
    const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
    if (idx < 1) continue;
    let total = 0, cnt = 0;
    for (let i = Math.max(0, idx - 20); i < idx; i++) {
      total += sd.candles[i].volume * sd.candles[i].close;
      cnt++;
    }
    list.push({ symbol, avg: cnt > 0 ? total / cnt : 0 });
  }
  list.sort((a, b) => b.avg - a.avg);
  return new Set(list.slice(0, topN).map(d => d.symbol));
}

// ══════════════════════════════════════════════════════════════
// 候選建立（六條件）
// ══════════════════════════════════════════════════════════════

function buildCandidate(
  symbol: string, name: string,
  candles: CandleWithIndicators[], idx: number,
  sortFn: (f: SixcondFeatures) => number,
  mtfMin: number,
): SixcondFeatures | null {
  if (idx < 60 || idx + 2 >= candles.length) return null;

  const six = evaluateSixConditions(candles, idx);
  if (!six.isCoreReady || six.totalScore < 5) return null;

  const c    = candles[idx];
  const prev = candles[idx - 1];
  const next = candles[idx + 1];

  const nextRange = next.high - next.low;
  if (next.open === next.high && next.low > 0 && nextRange / next.low * 100 < 0.5) return null;

  const changePercent = prev.close > 0 ? +((c.close - prev.close) / prev.close * 100).toFixed(2) : 0;
  const volumeRatio   = prev.volume > 0 ? c.volume / prev.volume : 1;
  const bodyPct       = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  const deviation     = six.position.deviation ?? 0;
  const mom5          = idx >= 5 && candles[idx - 5].close > 0
    ? (c.close / candles[idx - 5].close - 1) * 100 : 0;
  const turnover      = c.volume * c.close;
  const entryPrice    = +(next.open * (1 + SLIPPAGE_PCT)).toFixed(2);

  let resonanceScore = 0;
  try {
    const sigs = ruleEngine.evaluate(candles, idx);
    const buys = sigs.filter(s => s.type === 'BUY' || s.type === 'ADD');
    resonanceScore = buys.length + new Set(buys.map(s => s.ruleId.split('.')[0])).size;
  } catch { /* 略 */ }

  let highWinRateScore = 0;
  try { highWinRateScore = evaluateHighWinRateEntry(candles, idx).score; } catch { /* 略 */ }

  let mtfScore = 0;
  try {
    mtfScore = evaluateMultiTimeframe(candles.slice(0, idx + 1), MTF_CFG).totalScore;
  } catch { /* 略 */ }

  if (mtfMin > 0 && mtfScore < mtfMin) return null;

  const f: SixcondFeatures = {
    symbol, name, idx, candles, entryPrice,
    totalScore: six.totalScore, changePercent,
    volumeRatio, bodyPct, deviation, mom5, turnover,
    resonanceScore, highWinRateScore, mtfScore, rankScore: 0,
  };
  f.rankScore = sortFn(f);
  return f;
}

// ══════════════════════════════════════════════════════════════
// 賣出策略：S1
// ══════════════════════════════════════════════════════════════

function exitS1(
  candles: CandleWithIndicators[],
  entryIdx: number,
  entryPrice: number,
): ExitResult | null {
  let maxGain = 0;

  for (let d = 0; d <= S1_MAX_HOLD; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) break;
    const c    = candles[fi];
    const prev = fi > 0 ? candles[fi - 1] : null;

    const lowRet   = entryPrice > 0 ? (c.low   - entryPrice) / entryPrice * 100 : 0;
    const closeRet = entryPrice > 0 ? (c.close - entryPrice) / entryPrice * 100 : 0;
    if (closeRet > maxGain) maxGain = closeRet;

    if (d === 0) {
      if (closeRet <= S1_SL_PCT) return { exitIdx: fi, exitPrice: c.close, exitReason: `止損${S1_SL_PCT}%（進場日）` };
      continue;
    }

    if (lowRet <= S1_SL_PCT) {
      return { exitIdx: fi, exitPrice: +(entryPrice * (1 + S1_SL_PCT / 100)).toFixed(2), exitReason: `止損${S1_SL_PCT}%` };
    }

    if (maxGain >= S1_PROFIT_GATE && c.ma5 != null && c.close < c.ma5) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '漲超10%後跌破MA5' };
    }

    const vols5  = Array.from({ length: 5 }, (_, i) => candles[Math.max(0, fi - 1 - i)]?.volume ?? 0);
    const avgVol = vols5.reduce((a, b) => a + b, 0) / vols5.length;
    const volRatio = avgVol > 0 ? (c.volume ?? 0) / avgVol : 0;
    const body = Math.abs(c.close - c.open);

    if (fi >= 3) {
      const prev3Up     = [candles[fi-1], candles[fi-2], candles[fi-3]].every(x => x.close > x.open);
      const isLongBlack = c.close < c.open && body / c.open >= 0.02;
      if (prev3Up && isLongBlack && volRatio > 1.5) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '急漲後長黑K' };
      }
    }

    if (prev && prev.close > prev.open && c.close < c.open) {
      const midPrice   = (prev.open + prev.close) / 2;
      const kdDownTurn = c.kdK != null && prev.kdK != null && c.kdK < prev.kdK;
      if (c.close < midPrice && kdDownTurn) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '強覆蓋' };
      }
    }

    if (fi >= 10) {
      const recentHighs: number[] = [];
      for (let i = fi - 1; i >= Math.max(1, fi - 20) && recentHighs.length < 2; i--) {
        const ci = candles[i], pi = candles[i-1], ni = candles[i+1];
        if (ci && pi && ni && ci.high > pi.high && ci.high > ni.high) recentHighs.push(ci.high);
      }
      if (recentHighs.length >= 2 && recentHighs[0] < recentHighs[1] && c.close < recentHighs[0]) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '頭頭低' };
      }
    }

    if (c.kdK != null && c.kdD != null && prev?.kdK != null && prev.kdD != null) {
      if (prev.kdK > 70 && prev.kdK >= prev.kdD && c.kdK < c.kdD) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: 'KD高位死叉' };
      }
    }

    if (d === S1_MAX_HOLD) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: `持股${S1_MAX_HOLD}天到期` };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 單一組合回測
// ══════════════════════════════════════════════════════════════

function runCombo(
  combo: Combo,
  allStocks: Map<string, StockData>,
  tradingDays: string[],
  // topN快取（同市場/同topN共享，節省計算）
  topNCache: Map<string, Map<string, Set<string> | null>>,
): ComboResult {
  const { market, topN, mtfMin, sortBy } = combo;
  const costPct = market === 'TW' ? TW_COST_PCT : CN_COST_PCT;
  const sortFn  = SORT_DEFS[sortBy];

  const topNCacheKey = `${topN}`;
  if (!topNCache.has(topNCacheKey)) topNCache.set(topNCacheKey, new Map());
  const topNDateCache = topNCache.get(topNCacheKey)!;

  const trades: Trade[] = [];
  let capital = CAPITAL;
  let holdingUntilDayIdx = -1;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    if (dayIdx <= holdingUntilDayIdx) continue;

    const date = tradingDays[dayIdx];

    if (topN > 0 && !topNDateCache.has(date)) {
      topNDateCache.set(date, buildTopNSet(allStocks, date, topN));
    }
    const topNSet = topN > 0 ? topNDateCache.get(date) ?? null : null;

    const cands: SixcondFeatures[] = [];
    for (const [symbol, sd] of allStocks) {
      if (topNSet && !topNSet.has(symbol)) continue;
      const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 0) continue;
      const cand = buildCandidate(symbol, sd.name, sd.candles, idx, sortFn, mtfMin);
      if (cand) cands.push(cand);
    }

    if (cands.length === 0) continue;
    cands.sort((a, b) => b.rankScore - a.rankScore);
    const picked = cands[0];

    const entryDayIdx = picked.idx + 1;
    if (entryDayIdx >= picked.candles.length) continue;

    const exitResult = exitS1(picked.candles, entryDayIdx, picked.entryPrice);
    if (!exitResult) continue;

    const { exitIdx, exitPrice, exitReason } = exitResult;
    const exitDate    = picked.candles[exitIdx]?.date?.slice(0, 10) ?? '';
    const exitDayIdx  = tradingDays.indexOf(exitDate);

    const grossPct = (exitPrice - picked.entryPrice) / picked.entryPrice * 100;
    const netPct   = grossPct - costPct;
    const pnl      = capital * netPct / 100;
    capital        = Math.max(0, capital + pnl);

    const entryDate = picked.candles[entryDayIdx]?.date?.slice(0, 10) ?? '';
    trades.push({
      entryDate, exitDate,
      symbol:      picked.symbol,
      entryPrice:  picked.entryPrice,
      exitPrice,   exitReason,
      netPct:      +netPct.toFixed(3),
      pnl:         +pnl.toFixed(0),
      capitalAfter:+capital.toFixed(0),
      holdDays:    exitIdx - entryDayIdx,
    });

    holdingUntilDayIdx = exitDayIdx >= 0 ? exitDayIdx : dayIdx + (exitIdx - entryDayIdx);
  }

  const finalCapital = trades.at(-1)?.capitalAfter ?? CAPITAL;
  const totalReturn  = (finalCapital - CAPITAL) / CAPITAL * 100;
  const wins         = trades.filter(t => t.netPct > 0);
  const winRate      = trades.length > 0 ? wins.length / trades.length * 100 : 0;
  const avgHold      = trades.length > 0 ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length : 0;

  let peak = CAPITAL, maxDD = 0, cap = CAPITAL;
  for (const t of trades) {
    cap = t.capitalAfter;
    if (cap > peak) peak = cap;
    const dd = (peak - cap) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return { combo, totalReturn, tradeCount: trades.length, winRate, maxDD, avgHold, finalCapital };
}

// ══════════════════════════════════════════════════════════════
// 排行榜輸出
// ══════════════════════════════════════════════════════════════

function printLeaderboard(results: ComboResult[], market: 'TW' | 'CN'): void {
  const filtered = results.filter(r => r.combo.market === market);
  filtered.sort((a, b) => b.totalReturn - a.totalReturn);

  console.log('\n' + '═'.repeat(90));
  console.log(`  【${market}】排行榜  (共 ${filtered.length} 組，依總報酬排序)`);
  console.log('═'.repeat(90));
  console.log(
    '  排名  ' +
    '總報酬  '.padEnd(9) +
    '勝率   '.padEnd(8) +
    '最大回撤  '.padEnd(11) +
    '交易  '.padEnd(7) +
    '均持天  '.padEnd(8) +
    '前N   '.padEnd(7) +
    'MTF  '.padEnd(6) +
    '排序因子'
  );
  console.log('─'.repeat(90));

  filtered.slice(0, 30).forEach((r, i) => {
    const ret = (r.totalReturn >= 0 ? '+' : '') + r.totalReturn.toFixed(1) + '%';
    const wr  = r.winRate.toFixed(0) + '%';
    const dd  = r.maxDD.toFixed(1) + '%';
    const topLabel = r.combo.topN === 0 ? '全部' : `前${r.combo.topN}`;
    const mtfLabel = r.combo.mtfMin === 0 ? '不限' : `≥${r.combo.mtfMin}`;
    console.log(
      `  ${(i + 1).toString().padStart(3)}   ` +
      `${ret.padEnd(9)}${wr.padEnd(8)}${dd.padEnd(11)}` +
      `${r.tradeCount.toString().padEnd(7)}${r.avgHold.toFixed(1).padEnd(8)}` +
      `${topLabel.padEnd(7)}${mtfLabel.padEnd(6)}${r.combo.sortBy}`
    );
  });

  if (filtered.length > 30) {
    console.log(`  ... 還有 ${filtered.length - 30} 組（全部負報酬，省略）`);
  }

  // 冠軍組合
  const best = filtered[0];
  if (best) {
    console.log('\n  ★ 冠軍組合：');
    console.log(`    市場：${best.combo.market}`);
    console.log(`    前N篩選：${best.combo.topN === 0 ? '不篩（全部）' : '前' + best.combo.topN}`);
    console.log(`    MTF門檻：${best.combo.mtfMin === 0 ? '不篩' : '≥' + best.combo.mtfMin}`);
    console.log(`    排序因子：${best.combo.sortBy}`);
    console.log(`    總報酬：${(best.totalReturn >= 0 ? '+' : '') + best.totalReturn.toFixed(2)}%`);
    console.log(`    勝率：${best.winRate.toFixed(1)}%`);
    console.log(`    最大回撤：${best.maxDD.toFixed(1)}%`);
    console.log(`    交易筆數：${best.tradeCount}`);
    console.log(`    平均持股：${best.avgHold.toFixed(1)} 天`);
    console.log(`    最終資金：${best.finalCapital.toLocaleString()} 元`);
  }
  console.log('═'.repeat(90));
}

// ══════════════════════════════════════════════════════════════
// 主程式
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const combos  = buildCombos();
  const results: ComboResult[] = [];

  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║   全因子組合批量回測                 ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log(`  週期：${PERIOD.start} ～ ${PERIOD.end}`);
  console.log(`  初始籌碼：${CAPITAL.toLocaleString()} 元`);
  console.log(`  賣出策略：S1（止損-5% + 曾漲超10%後跌破MA5）`);
  console.log(`  總組合數：${combos.length}\n`);

  for (const market of MARKETS_TO_RUN) {
    // 每個市場只載入一次資料
    console.log(`\n━━━ 載入 ${market} 資料 ━━━`);
    const allStocks = loadStocks(market);

    // 取回測期間交易日
    const tradingDaySet = new Set<string>();
    for (const [, sd] of allStocks) {
      for (const c of sd.candles) {
        const d = c.date?.slice(0, 10);
        if (d && d >= PERIOD.start && d <= PERIOD.end) tradingDaySet.add(d);
      }
    }
    const tradingDays = [...tradingDaySet].sort();
    console.log(`  交易日：${tradingDays[0]} ～ ${tradingDays.at(-1)} 共 ${tradingDays.length} 天`);

    // topN 快取（同市場下共享）
    const topNCache = new Map<string, Map<string, Set<string> | null>>();

    const marketCombos = combos.filter(c => c.market === market);
    console.log(`  開始跑 ${marketCombos.length} 組合...\n`);

    let done = 0;
    for (const combo of marketCombos) {
      const result = runCombo(combo, allStocks, tradingDays, topNCache);
      results.push(result);
      done++;

      // 進度每20組顯示一行
      if (done % 20 === 0 || done === marketCombos.length) {
        const pct = (done / marketCombos.length * 100).toFixed(0);
        process.stdout.write(`  進度：${done}/${marketCombos.length} (${pct}%)\r`);
      }
    }
    process.stdout.write('\n');

    printLeaderboard(results, market);
  }

  // 如果跑了兩個市場，最後再印一次跨市場前10
  if (MARKETS_TO_RUN.length > 1) {
    const sorted = [...results].sort((a, b) => b.totalReturn - a.totalReturn);
    console.log('\n' + '═'.repeat(90));
    console.log('  【全市場 Top 10】');
    console.log('═'.repeat(90));
    sorted.slice(0, 10).forEach((r, i) => {
      const ret = (r.totalReturn >= 0 ? '+' : '') + r.totalReturn.toFixed(1) + '%';
      const topLabel = r.combo.topN === 0 ? '全部' : `前${r.combo.topN}`;
      const mtfLabel = r.combo.mtfMin === 0 ? '不限' : `≥${r.combo.mtfMin}`;
      console.log(
        `  ${(i+1).toString().padStart(2)}. ${r.combo.market}  ` +
        `${ret.padEnd(9)}勝率${r.combo.sortBy.padEnd(12)}` +
        `${topLabel} MTF${mtfLabel}`
      );
    });
    console.log('═'.repeat(90));
  }
}

main().catch(console.error);
