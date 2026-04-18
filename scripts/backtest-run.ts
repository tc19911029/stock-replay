/**
 * 模組化回測框架
 *
 * 修改下方 CONFIG 即可切換所有參數，不需動其他地方。
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-run.ts
 */

import fs   from 'fs';
import path from 'path';
import { computeIndicators }          from '@/lib/indicators';
import { evaluateSixConditions }      from '@/lib/analysis/trendAnalysis';
import { evaluateMultiTimeframe }     from '@/lib/analysis/multiTimeframeFilter';
import { evaluateHighWinRateEntry }   from '@/lib/analysis/highWinRateEntry';
import { checkLongProhibitions }      from '@/lib/rules/entryProhibitions';
import { evaluateElimination }        from '@/lib/scanner/eliminationFilter';
import type { CandleWithIndicators }  from '@/types';
import { BASE_THRESHOLDS, ZHU_OPTIMIZED } from '@/lib/strategy/StrategyConfig';

// ══════════════════════════════════════════════════════════════
// ★ 在這裡修改回測設定 ★
// ══════════════════════════════════════════════════════════════

const CONFIG = {
  /** 市場 */
  market: 'TW' as 'TW' | 'CN',

  /** 回測週期（YYYY-MM-DD） */
  period: {
    start: '2026-03-19',
    end:   '2026-04-17',
  },

  /** 買入方法：B1 = all-in排名第1，賣了才有錢買下一支 */
  buyMode: 'B1' as const,

  /** 初始籌碼 */
  capital: 1_000_000,

  /** 選股策略 */
  strategy: 'SIXCOND' as 'SIXCOND' | 'DABAN',

  /**
   * 六條件排序設定（strategy = 'SIXCOND' 時使用）
   *   topN   ─ 前N支20日均成交額篩選；0 = 不篩
   *   mtfMin ─ MTF最低分（0~4）；0 = 不篩
   *   sortBy ─ 最終排序依據（見 SIXCOND_SORT_DEFS）
   */
  sixcond: {
    topN:   500,
    mtfMin: 0,          // 對齊面板 daily session（不開 MTF）
    sortBy: '漲幅' as SixcondSort,
  },

  /**
   * 打板排序設定（strategy = 'DABAN' 時使用）
   *   sortBy  ─ 排序依據（見 DABAN_SORT_DEFS）
   *   gapMin  ─ 高開最低幅度(%)，低於此跳過
   *   gapMax  ─ 高開最高幅度(%)，高於此跳過（太接近漲停無獲利空間）
   */
  daban: {
    sortBy: '純成交額' as DabanSort,
    gapMin: 2.0,
    gapMax: 8.0,
  },

  /**
   * 賣出策略
   *   S1 ─ 固定止損-5% + 曾漲超10%後跌破MA5 + 附屬條件（頭頭低/大量長黑/強覆蓋/KD死叉）
   */
  exitStrategy: 'S1' as 'S1',
} as const;

// ══════════════════════════════════════════════════════════════
// 型別定義
// ══════════════════════════════════════════════════════════════

type SixcondSort =
  | '六條件總分' | '成交額' | '量比' | '動能' | 'K棒實體'
  | '乖離率低' | '漲幅' | '綜合因子' | '高勝率';

type DabanSort =
  | '純成交額' | '封板力度' | '多因子' | '連板優先'
  | '量比優先' | '動能優先' | '高開幅度' | '封板+高開';

interface StockData {
  name:    string;
  candles: CandleWithIndicators[];
}

interface SixcondFeatures {
  symbol: string; name: string; idx: number; candles: CandleWithIndicators[];
  entryPrice: number; totalScore: number; changePercent: number;
  volumeRatio: number; bodyPct: number; deviation: number;
  mom5: number; turnover: number;
  highWinRateScore: number; mtfScore: number;
  rankScore: number;
}

interface DabanFeatures {
  symbol: string; name: string; idx: number; candles: CandleWithIndicators[];
  entryPrice: number;
  gapUp: number; boards: number; yestClose: number;
  yestTurnover: number; yestVR: number; seal: number; mom5: number;
  rankScore: number;
}

type Features = SixcondFeatures | DabanFeatures;

interface ExitResult {
  exitIdx:    number;
  exitPrice:  number;
  exitReason: string;
}

interface Trade {
  no:          number;
  entryDate:   string;
  exitDate:    string;
  symbol:      string;
  name:        string;
  entryPrice:  number;
  exitPrice:   number;
  netPct:      number;
  pnl:         number;
  capitalAfter:number;
  holdDays:    number;
  exitReason:  string;
}

// ══════════════════════════════════════════════════════════════
// 常數
// ══════════════════════════════════════════════════════════════

const SLIPPAGE_PCT  = 0.001;
const TW_COST_PCT   = (0.001425 * 0.6 * 2 + 0.003) * 100; // ≈ 0.471%
const CN_COST_PCT   = 0.16;
const MTF_CFG       = { ...BASE_THRESHOLDS, multiTimeframeFilter: true };
const LIMIT_UP_PCT  = 9.5;
const MIN_TURNOVER  = 5_000_000;

// ── S1 出場參數 ───────────────────────────────────────────────
const S1_SL_PCT          = -5;    // 固定止損
const S1_PROFIT_GATE_PCT = 10;    // 啟動MA5保護的獲利門檻
const S1_MAX_HOLD        = 60;    // 最長持有天數

// ══════════════════════════════════════════════════════════════
// 排序因子定義
// ══════════════════════════════════════════════════════════════

const SIXCOND_SORT_DEFS: Record<SixcondSort, (f: SixcondFeatures) => number> = {
  // 對齊 lib/selection/applyPanelFilter.ts 排序：六條件總分 desc，同分以高勝率次要
  '六條件總分':   f => f.totalScore * 1000 + f.highWinRateScore * 10 + f.changePercent / 100,
  '成交額':       f => Math.log10(Math.max(f.turnover, 1)),
  '量比':         f => Math.min(f.volumeRatio, 5) * 2 + f.changePercent / 10,
  '動能':         f => f.mom5 + f.changePercent / 10,
  'K棒實體':      f => f.bodyPct * 100 + f.changePercent / 10,
  '乖離率低':     f => -f.deviation * 100 + f.changePercent / 10,
  '漲幅':         f => f.changePercent,
  '綜合因子':     f => Math.min(f.volumeRatio, 5) / 5 + Math.max(0, f.mom5) / 20
                       + Math.min(f.bodyPct * 100, 10) / 10 + f.changePercent / 10,
  '高勝率':       f => f.highWinRateScore + f.changePercent / 10,
};

const DABAN_SORT_DEFS: Record<DabanSort, (f: DabanFeatures) => number> = {
  '純成交額':   f => Math.log10(Math.max(f.yestTurnover, 1)),
  '封板力度':   f => f.seal * 10 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '多因子':     f => f.seal * 2 + Math.min(f.yestVR, 5) / 5
                     + Math.max(0, f.mom5) / 20
                     + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '連板優先':   f => f.boards * 3 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '量比優先':   f => Math.min(f.yestVR, 5) * 2 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '動能優先':   f => Math.max(0, f.mom5) / 5 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '高開幅度':   f => f.gapUp * 2 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '封板+高開':  f => f.seal * 3 + f.gapUp,
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
// 選股策略：六條件（SIXCOND）
// ══════════════════════════════════════════════════════════════

/** 計算每支股票20日均成交額，回傳前 topN 的 symbol set */
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

function buildSixcondCandidate(
  symbol: string, name: string,
  candles: CandleWithIndicators[], idx: number,
  sortFn: (f: SixcondFeatures) => number,
  mtfMin: number,
): SixcondFeatures | null {
  if (idx < 60 || idx + 2 >= candles.length) return null;

  // 對齊生產：量比 1.5（ZHU_OPTIMIZED），不是書本 1.3
  const six = evaluateSixConditions(candles, idx, ZHU_OPTIMIZED.thresholds);
  if (!six.isCoreReady || six.totalScore < 5) return null;

  // 對齊生產：10 大戒律 + 淘汰法 R1-R11
  if (checkLongProhibitions(candles, idx).prohibited) return null;
  if (evaluateElimination(candles, idx).eliminated)   return null;

  const c    = candles[idx];
  const prev = candles[idx - 1];
  const next = candles[idx + 1];

  // 隔天一字跌停：無法買入
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
    highWinRateScore, mtfScore, rankScore: 0,
  };
  f.rankScore = sortFn(f);
  return f;
}

// ══════════════════════════════════════════════════════════════
// 選股策略：打板（DABAN）
// ══════════════════════════════════════════════════════════════

function dayGain(candles: CandleWithIndicators[], idx: number): number {
  if (idx <= 0) return 0;
  const p = candles[idx - 1].close;
  return p > 0 ? (candles[idx].close - p) / p * 100 : 0;
}

function consecutiveLimitUp(candles: CandleWithIndicators[], idx: number): number {
  let n = 0;
  for (let i = idx; i >= 1; i--) {
    if (dayGain(candles, i) >= LIMIT_UP_PCT) n++;
    else break;
  }
  return n;
}

function buildDabanCandidate(
  symbol: string, name: string,
  candles: CandleWithIndicators[], idx: number,
  sortFn: (f: DabanFeatures) => number,
): DabanFeatures | null {
  if (idx < 10 || idx + 3 >= candles.length) return null;

  const today = candles[idx];
  const yest  = candles[idx - 1];
  const db    = candles[idx - 2];

  // 昨日漲停
  const yestGain = db.close > 0 ? (yest.close - db.close) / db.close * 100 : 0;
  if (yestGain < LIMIT_UP_PCT) return null;

  // 昨天不能是一字板（散戶買不到）
  if (yest.open === yest.high && yest.high === yest.close) return null;

  const yestVol     = yest.volume ?? 0;
  const yestTurnover = yestVol * yest.close;
  if (yestTurnover < MIN_TURNOVER) return null;

  const gapUp = yest.close > 0 ? (today.open - yest.close) / yest.close * 100 : 0;
  if (gapUp < 2.0) return null; // 基本門檻（實際範圍在主循環過濾）

  const boards   = consecutiveLimitUp(candles, idx - 1);
  const vols5    = Array.from({ length: 5 }, (_, i) => candles[idx - 1 - i]?.volume ?? 0);
  const avgVol5  = vols5.reduce((a, b) => a + b, 0) / vols5.length;
  const yestVR   = avgVol5 > 0 ? yestVol / avgVol5 : 1;
  const yRange   = yest.high - yest.low;
  const upperShadow = yest.high - Math.max(yest.open, yest.close);
  const seal     = yRange > 0 ? 1 - upperShadow / yRange : 1;
  const mom5     = idx >= 6 ? (yest.close / candles[idx - 6].close - 1) * 100 : 0;

  const f: DabanFeatures = {
    symbol, name, idx, candles,
    entryPrice: today.open,
    gapUp: +gapUp.toFixed(2),
    boards, yestClose: yest.close, yestTurnover, yestVR, seal, mom5,
    rankScore: 0,
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
  let maxGain = 0; // 曾達到最高收益率，不可逆

  // 書本獲利方程式 ①：停損點設在進場中長紅 K 線的最低點（典型落在 5~7%）
  // 若進場低點離進場價超過 -7%（異常），硬性 cap 在 -7% 保護
  const entryCandle = candles[entryIdx];
  const rawStopPrice = entryCandle?.low ?? entryPrice * 0.93;
  const floorPrice   = entryPrice * 0.93;  // -7% 硬性下限
  const stopLossPrice = Math.max(rawStopPrice, floorPrice);
  const stopLossPct   = entryPrice > 0 ? (stopLossPrice - entryPrice) / entryPrice * 100 : -5;

  for (let d = 0; d <= S1_MAX_HOLD; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) break;
    const c    = candles[fi];
    const prev = fi > 0 ? candles[fi - 1] : null;

    const closeRet = entryPrice > 0 ? (c.close - entryPrice) / entryPrice * 100 : 0;
    if (closeRet > maxGain) maxGain = closeRet;

    // 進場日只看收盤止損（收盤跌破進場 K 最低點）
    if (d === 0) {
      if (c.close <= stopLossPrice) return { exitIdx: fi, exitPrice: c.close, exitReason: `止損${stopLossPct.toFixed(1)}%（進場日）` };
      continue;
    }

    // ① 收盤跌破進場 K 最低點（書本停損規則）
    if (c.close <= stopLossPrice) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: `止損${stopLossPct.toFixed(1)}% 進場K低點 ${stopLossPrice.toFixed(2)}` };
    }

    // ② 曾漲超10%後跌破MA5（S1核心保護）
    if (maxGain >= S1_PROFIT_GATE_PCT && c.ma5 != null && c.close < c.ma5) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '漲超10%後跌破MA5' };
    }

    // 附屬條件
    const vols5  = Array.from({ length: 5 }, (_, i) => candles[Math.max(0, fi - 1 - i)]?.volume ?? 0);
    const avgVol = vols5.reduce((a, b) => a + b, 0) / vols5.length;
    const volRatio = avgVol > 0 ? (c.volume ?? 0) / avgVol : 0;
    const body = Math.abs(c.close - c.open);

    // ③ 急漲後大量長黑K
    if (fi >= 3) {
      const prev3Up     = [candles[fi-1], candles[fi-2], candles[fi-3]].every(x => x.close > x.open);
      const isLongBlack = c.close < c.open && body / c.open >= 0.02;
      if (prev3Up && isLongBlack && volRatio > 1.5) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '急漲後長黑K' };
      }
    }

    // ④ 強覆蓋（黑K破前日紅K一半 + KD下彎）
    if (prev && prev.close > prev.open && c.close < c.open) {
      const midPrice   = (prev.open + prev.close) / 2;
      const kdDownTurn = c.kdK != null && prev.kdK != null && c.kdK < prev.kdK;
      if (c.close < midPrice && kdDownTurn) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '強覆蓋' };
      }
    }

    // ⑤ 頭頭低
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

    // ⑥ KD 高位死叉（KD > 70 時交叉）
    if (c.kdK != null && c.kdD != null && prev?.kdK != null && prev.kdD != null) {
      if (prev.kdK > 70 && prev.kdK >= prev.kdD && c.kdK < c.kdD) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: 'KD高位死叉' };
      }
    }

    // ⑦ 安全網
    if (d === S1_MAX_HOLD) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: `持股${S1_MAX_HOLD}天到期` };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 買入方法：B1（all-in 排名第1，一次一支）
// ══════════════════════════════════════════════════════════════

function runB1(
  allStocks: Map<string, StockData>,
  tradingDays: string[],
): Trade[] {
  const { market, capital: initCapital, strategy, sixcond, daban, exitStrategy } = CONFIG;
  const costPct = market === 'TW' ? TW_COST_PCT : CN_COST_PCT;

  const sixSortFn = SIXCOND_SORT_DEFS[sixcond.sortBy];
  const dabanSortFn = DABAN_SORT_DEFS[daban.sortBy];

  const trades: Trade[] = [];
  let capital = initCapital;
  let holdingUntilDayIdx = -1;

  // 預計算前N集合（六條件用）
  const topNCache = new Map<string, Set<string> | null>();

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    if (dayIdx <= holdingUntilDayIdx) continue;

    const date = tradingDays[dayIdx];

    // ── 打板：市場冷度檢查 ────────────────────────────────────
    if (strategy === 'DABAN') {
      const coldThreshold = market === 'CN' ? 15 : 5;
      let limitUpCount = 0;
      for (const [, sd] of allStocks) {
        const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
        if (idx < 2) continue;
        if (dayGain(sd.candles, idx - 1) >= LIMIT_UP_PCT) limitUpCount++;
      }
      if (limitUpCount < coldThreshold) continue;
    }

    // ── 六條件：前N集合 ───────────────────────────────────────
    if (strategy === 'SIXCOND' && sixcond.topN > 0 && !topNCache.has(date)) {
      topNCache.set(date, buildTopNSet(allStocks, date, sixcond.topN));
    }
    const topNSet = topNCache.get(date) ?? null;

    // ── 建立候選 ──────────────────────────────────────────────
    const cands: Features[] = [];
    for (const [symbol, sd] of allStocks) {
      const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 0) continue;

      if (strategy === 'SIXCOND') {
        if (topNSet && !topNSet.has(symbol)) continue;
        const cand = buildSixcondCandidate(symbol, sd.name, sd.candles, idx, sixSortFn, sixcond.mtfMin);
        if (cand) cands.push(cand);
      } else {
        const cand = buildDabanCandidate(symbol, sd.name, sd.candles, idx, dabanSortFn);
        if (cand) cands.push(cand);
      }
    }

    if (cands.length === 0) continue;
    cands.sort((a, b) => b.rankScore - a.rankScore);

    // ── 選第1名（打板需額外過濾高開範圍）────────────────────
    let picked: Features | null = null;
    if (strategy === 'SIXCOND') {
      picked = cands[0];
    } else {
      for (const c of cands as DabanFeatures[]) {
        if (c.gapUp >= LIMIT_UP_PCT) continue;  // 一字板
        if (c.gapUp >= daban.gapMax) continue;  // 空間不足
        if (c.gapUp <  daban.gapMin) continue;  // 高開不足
        picked = c;
        break;
      }
    }
    if (!picked) continue;

    // ── 計算進場日 ────────────────────────────────────────────
    const entryDayIdx = picked.idx + (strategy === 'SIXCOND' ? 1 : 0);
    if (entryDayIdx >= picked.candles.length) continue;
    const entryPrice = picked.entryPrice;

    // ── 出場模擬 ──────────────────────────────────────────────
    let exitResult: ExitResult | null = null;
    if (exitStrategy === 'S1') {
      exitResult = exitS1(picked.candles, entryDayIdx, entryPrice);
    }
    if (!exitResult) continue;

    const { exitIdx, exitPrice, exitReason } = exitResult;
    const exitDate  = picked.candles[exitIdx]?.date?.slice(0, 10) ?? '';
    const exitDayIdx = tradingDays.indexOf(exitDate);

    // ── 損益計算 ──────────────────────────────────────────────
    const grossPct = (exitPrice - entryPrice) / entryPrice * 100;
    const netPct   = grossPct - costPct;
    const pnl      = capital * netPct / 100;
    capital        = Math.max(0, capital + pnl);

    const entryDate  = picked.candles[entryDayIdx]?.date?.slice(0, 10) ?? '';
    const holdDays   = exitIdx - entryDayIdx;

    trades.push({
      no:          trades.length + 1,
      entryDate, exitDate,
      symbol:      picked.symbol,
      name:        picked.name,
      entryPrice,  exitPrice,
      netPct:      +netPct.toFixed(3),
      pnl:         +pnl.toFixed(0),
      capitalAfter:+capital.toFixed(0),
      holdDays,    exitReason,
    });

    holdingUntilDayIdx = exitDayIdx >= 0 ? exitDayIdx : dayIdx + holdDays;
  }

  return trades;
}

// ══════════════════════════════════════════════════════════════
// 報告輸出
// ══════════════════════════════════════════════════════════════

function report(trades: Trade[], initialCapital: number): void {
  const { market, period, buyMode, capital, strategy, exitStrategy, sixcond, daban } = CONFIG;

  // 設定摘要
  const strategyLabel = strategy === 'SIXCOND'
    ? `六條件 / 前${sixcond.topN}成交額 + MTF≥${sixcond.mtfMin} + ${sixcond.sortBy}`
    : `打板 / ${daban.sortBy} / 高開${daban.gapMin}~${daban.gapMax}%`;

  console.log('\n' + '═'.repeat(72));
  console.log('  回測設定');
  console.log('═'.repeat(72));
  console.log(`  市場          ${market}`);
  console.log(`  週期          ${period.start} ～ ${period.end}`);
  console.log(`  買入方法      ${buyMode}（all-in排名第1，賣了才買）`);
  console.log(`  初始籌碼      ${initialCapital.toLocaleString()} 元`);
  console.log(`  選股策略      ${strategyLabel}`);
  console.log(`  賣出策略      ${exitStrategy}`);
  console.log('═'.repeat(72));

  if (trades.length === 0) {
    console.log('\n  ⚠ 無交易記錄');
    return;
  }

  const finalCapital = trades.at(-1)!.capitalAfter;
  const totalReturn  = (finalCapital - initialCapital) / initialCapital * 100;
  const wins         = trades.filter(t => t.netPct > 0);
  const losses       = trades.filter(t => t.netPct <= 0);
  const winRate      = wins.length / trades.length * 100;
  const avgWin       = wins.length  > 0 ? wins.reduce((s, t)   => s + t.netPct, 0) / wins.length   : 0;
  const avgLoss      = losses.length > 0 ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;
  const avgHold      = trades.reduce((s, t) => s + t.holdDays, 0) / trades.length;

  // 最大回撤
  let peak = initialCapital, maxDD = 0;
  let cap  = initialCapital;
  for (const t of trades) {
    cap = t.capitalAfter;
    if (cap > peak) peak = cap;
    const dd = (peak - cap) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // 連勝/連敗
  let maxWinStreak = 0, maxLossStreak = 0, streak = 0, lastType = '';
  for (const t of trades) {
    const type = t.netPct > 0 ? 'W' : 'L';
    if (type === lastType) streak++;
    else { streak = 1; lastType = type; }
    if (type === 'W' && streak > maxWinStreak)  maxWinStreak  = streak;
    if (type === 'L' && streak > maxLossStreak) maxLossStreak = streak;
  }

  // 出場原因統計
  const reasons = new Map<string, number>();
  for (const t of trades) reasons.set(t.exitReason, (reasons.get(t.exitReason) ?? 0) + 1);

  console.log('\n  績效摘要');
  console.log('─'.repeat(72));
  console.log(`  總報酬      ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(1)}%`);
  console.log(`  最終資金    ${finalCapital.toLocaleString()} 元`);
  console.log(`  交易筆數    ${trades.length} 筆`);
  console.log(`  勝率        ${winRate.toFixed(1)}%  （${wins.length}勝 / ${losses.length}負）`);
  console.log(`  平均獲利    +${avgWin.toFixed(2)}%`);
  console.log(`  平均虧損    ${avgLoss.toFixed(2)}%`);
  console.log(`  平均持股    ${avgHold.toFixed(1)} 天`);
  console.log(`  最大回撤    ${maxDD.toFixed(1)}%`);
  console.log(`  最大連勝    ${maxWinStreak} 次`);
  console.log(`  最大連敗    ${maxLossStreak} 次`);

  console.log('\n  出場原因');
  console.log('─'.repeat(72));
  for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = (count / trades.length * 100).toFixed(0);
    console.log(`  ${reason.padEnd(20)} ${count.toString().padStart(3)} 筆  ${pct.padStart(3)}%`);
  }

  console.log('\n  逐筆交易');
  console.log('─'.repeat(72));
  console.log(
    '  #'.padEnd(5) +
    '進場日'.padEnd(12) + '出場日'.padEnd(12) +
    '代號'.padEnd(10) + '名稱'.padEnd(12) +
    '進場'.padEnd(8) + '出場'.padEnd(8) +
    '報酬%'.padEnd(9) + '損益'.padEnd(10) +
    '持天'.padEnd(5) + '原因'
  );
  for (const t of trades) {
    const ret = (t.netPct >= 0 ? '+' : '') + t.netPct.toFixed(2) + '%';
    const pnl = (t.pnl >= 0 ? '+' : '') + t.pnl.toLocaleString();
    console.log(
      `  ${t.no.toString().padStart(3)}  ` +
      `${t.entryDate.padEnd(12)}${t.exitDate.padEnd(12)}` +
      `${t.symbol.padEnd(10)}${t.name.slice(0, 10).padEnd(12)}` +
      `${t.entryPrice.toFixed(2).padEnd(8)}${t.exitPrice.toFixed(2).padEnd(8)}` +
      `${ret.padEnd(9)}${pnl.padEnd(10)}` +
      `${t.holdDays.toString().padStart(3)}天  ${t.exitReason}`
    );
  }
  console.log('═'.repeat(72) + '\n');
}

// ══════════════════════════════════════════════════════════════
// 主程式
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const { market, period, capital } = CONFIG;

  console.log('\n  載入資料...');
  const allStocks = loadStocks(market);

  // 取得回測期間的交易日
  const tradingDaySet = new Set<string>();
  for (const [, sd] of allStocks) {
    for (const c of sd.candles) {
      const d = c.date?.slice(0, 10);
      if (d && d >= period.start && d <= period.end) tradingDaySet.add(d);
    }
  }
  const tradingDays = [...tradingDaySet].sort();
  console.log(`  交易日：${tradingDays[0]} ～ ${tradingDays.at(-1)} 共 ${tradingDays.length} 天`);

  console.log('  執行回測...');
  const trades = runB1(allStocks, tradingDays);

  report(trades, capital);
}

main().catch(console.error);
