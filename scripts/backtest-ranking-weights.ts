/**
 * 回測排序權重：共振 vs 高勝率進場
 *
 * 邏輯：
 * 1. 取股票池（台股 ~1900 支 / 陸股 ~900 支）
 * 2. 用 Yahoo Finance 20 並發下載 2 年日K（第一次 ~3min，之後讀快取 <1s）
 * 3. 對 2025/4 ~ 2026/4 每個交易日，本地模擬選股
 * 4. 6 種權重配比各取排名第 1 名
 * 5. 看第 1 名的 5日/10日/20日 實際報酬
 * 6. 統計哪個權重組合表現最好
 *
 * Usage:
 *   npx tsx scripts/backtest-ranking-weights.ts          # 台股（預設）
 *   npx tsx scripts/backtest-ranking-weights.ts --market CN  # 陸股
 */
import fs from 'fs';
import path from 'path';
import { computeIndicators } from '../lib/indicators';
import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { evaluateSixConditions } from '../lib/analysis/trendAnalysis';
import { checkLongProhibitions } from '../lib/rules/entryProhibitions';
import { evaluateElimination } from '../lib/scanner/eliminationFilter';
import { evaluateHighWinRateEntry } from '../lib/analysis/highWinRateEntry';
import { ruleEngine } from '../lib/rules/ruleEngine';
import { ZHU_V1 } from '../lib/strategy/StrategyConfig';
import type { CandleWithIndicators, Candle } from '../types';

// ── 回測參數 ─────────────────────────────────────────────────────────────────
const BACKTEST_START = '2024-04-01';
const BACKTEST_END   = '2026-04-04';
const FORWARD_DAYS   = [1, 2, 3, 4, 5, 10, 20];  // 前瞻報酬天數

// 6 種權重配比 (resonanceWeight : highWinRateWeight)
const WEIGHT_COMBOS = [
  { name: 'A: 共振100%',     rW: 1.0, hW: 0.0 },
  { name: 'B: 共振80%+高勝20%', rW: 0.8, hW: 0.2 },
  { name: 'C: 共振70%+高勝30%', rW: 0.7, hW: 0.3 },
  { name: 'D: 等權50:50',     rW: 0.5, hW: 0.5 },
  { name: 'E: 共振30%+高勝70%', rW: 0.3, hW: 0.7 },
  { name: 'F: 高勝100%',     rW: 0.0, hW: 1.0 },
];

const thresholds = ZHU_V1.thresholds;

// ── Yahoo Finance 直接下載 ───────────────────────────────────────────────────

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
};

function parseYahooCandles(json: unknown): Candle[] {
  const result = (json as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as {
    timestamp?: number[];
    indicators?: {
      quote?: { open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }[];
      adjclose?: { adjclose: number[] }[];
    };
  } | undefined;
  if (!result) return [];

  const timestamps: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  const adj = result.indicators?.adjclose?.[0]?.adjclose as number[] | undefined;
  if (!q) return [];

  return timestamps
    .map((ts, i) => {
      const o = q.open[i]; const h = q.high[i];
      const l = q.low[i];  const c = q.close[i];
      const v = q.volume[i];
      if (o == null || h == null || l == null || c == null || isNaN(o)) return null;
      const adjFactor = (adj && adj[i] != null && c > 0) ? adj[i] / c : 1;
      return {
        date:   new Date(ts * 1000).toISOString().split('T')[0],
        open:   +(o * adjFactor).toFixed(2),
        high:   +(h * adjFactor).toFixed(2),
        low:    +(l * adjFactor).toFixed(2),
        close:  +(c * adjFactor).toFixed(2),
        volume: adjFactor !== 1 ? Math.round((v ?? 0) / adjFactor) : (v ?? 0),
      };
    })
    .filter((c): c is Candle => c != null);
}

async function fetchYahooCandles(symbol: string): Promise<CandleWithIndicators[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5y&includePrePost=false&events=div,split`;
  const res = await fetch(url, {
    headers: YF_HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${symbol}`);
  const candles = parseYahooCandles(await res.json());
  if (candles.length < 60) throw new Error(`${symbol}: only ${candles.length} candles`);
  return computeIndicators(candles);
}

// ── 快取 ─────────────────────────────────────────────────────────────────────

const CACHE_DIR = path.join(process.cwd(), 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'backtest-candles.json');
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

interface CacheData {
  savedAt: string;
  stocks: Record<string, { name: string; candles: Candle[] }>;
}

function loadCache(cacheFile = CACHE_FILE): Map<string, { candles: CandleWithIndicators[]; name: string }> | null {
  try {
    if (!fs.existsSync(cacheFile)) return null;
    const raw: CacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    const age = Date.now() - new Date(raw.savedAt).getTime();
    if (age > CACHE_MAX_AGE_MS) {
      console.log('   快取已過期（>7天），重新下載');
      return null;
    }
    const map = new Map<string, { candles: CandleWithIndicators[]; name: string }>();
    for (const [symbol, data] of Object.entries(raw.stocks)) {
      if (data.candles.length >= 60) {
        map.set(symbol, { candles: computeIndicators(data.candles), name: data.name });
      }
    }
    console.log(`   ✅ 從快取載入 ${map.size} 支股票（${raw.savedAt}）`);
    return map;
  } catch {
    return null;
  }
}

function saveCache(
  allCandles: Map<string, { candles: CandleWithIndicators[]; name: string }>,
  cacheFile = CACHE_FILE,
): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const stocks: Record<string, { name: string; candles: Candle[] }> = {};
  for (const [symbol, data] of allCandles) {
    stocks[symbol] = {
      name: data.name,
      candles: data.candles.map(c => ({
        date: c.date, open: c.open, high: c.high,
        low: c.low, close: c.close, volume: c.volume,
      })),
    };
  }
  const cache: CacheData = { savedAt: new Date().toISOString(), stocks };
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  console.log(`   💾 已存快取到 ${cacheFile}（${allCandles.size} 支）`);
}

// ── 工具函數 ─────────────────────────────────────────────────────────────────

/** 找 candles 中 date 的 index */
function findDateIndex(candles: CandleWithIndicators[], targetDate: string): number {
  for (let i = candles.length - 1; i >= 0; i--) {
    const d = candles[i].date?.slice(0, 10);
    if (d && d <= targetDate) return i;
  }
  return -1;
}

/** 取得交易日清單（從 0050 的 candles 提取）*/
function getTradingDays(candles: CandleWithIndicators[]): string[] {
  return candles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);
}

/** 本地評估一支股票在特定 index 是否通過選股 */
function evaluateStock(candles: CandleWithIndicators[], lastIdx: number): {
  pass: boolean;
  resonanceScore: number;
  highWinRateScore: number;
} | null {
  if (lastIdx < 30) return null;
  const last = candles[lastIdx];

  // 六條件前5個
  const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
  if (!sixConds.isCoreReady) return null;

  // 短線第9條：KD向下不買
  if (last.kdK != null && lastIdx > 0) {
    const prevKdK = candles[lastIdx - 1]?.kdK;
    if (prevKdK != null && last.kdK < prevKdK) return null;
  }

  // 短線第10條：上影線>1/2不買
  const dayRange = last.high - last.low;
  const upperShadow = last.high - last.close;
  if (dayRange > 0 && upperShadow / dayRange > 0.5) return null;

  // 10大戒律
  const prohib = checkLongProhibitions(candles, lastIdx);
  if (prohib.prohibited) return null;

  // 淘汰法
  const elimination = evaluateElimination(candles, lastIdx);
  if (elimination.eliminated) return null;

  // ── 排序因子 ──────────────────────────────────────────────────────
  const signals = ruleEngine.evaluate(candles, lastIdx);
  const buySignals = signals.filter(s => s.type === 'BUY' || s.type === 'ADD');
  const uniqueGroups = new Set(buySignals.map(s =>
    'groupId' in s ? (s as { groupId: string }).groupId : s.ruleId.split('.')[0]
  ));
  const resonanceScore = buySignals.length + uniqueGroups.size;

  let highWinRateScore = 0;
  try {
    const hwr = evaluateHighWinRateEntry(candles, lastIdx);
    highWinRateScore = hwr.score;
  } catch { /* non-critical */ }

  return { pass: true, resonanceScore, highWinRateScore };
}

/** 計算前瞻報酬 */
function forwardReturn(candles: CandleWithIndicators[], signalIdx: number, days: number): number | null {
  const exitIdx = signalIdx + days;
  if (exitIdx >= candles.length) return null;
  const entryPrice = candles[signalIdx].close;
  const exitPrice = candles[exitIdx].close;
  if (!entryPrice || entryPrice <= 0) return null;
  return ((exitPrice - entryPrice) / entryPrice) * 100;
}

// ── 主程式 ───────────────────────────────────────────────────────────────────

interface PickResult {
  symbol: string;
  name: string;
  score: number;
  resonance: number;
  highWinRate: number;
  [key: `ret${number}d`]: number | null;
}

interface DayResult {
  date: string;
  candidateCount: number;
  picks: Record<string, PickResult | null>;
}

async function main() {
  // 解析市場參數
  const marketArg = process.argv.find(a => a === '--market');
  const marketIdx = process.argv.indexOf('--market');
  const market = marketIdx >= 0 ? (process.argv[marketIdx + 1] ?? 'TW') : 'TW';
  const marketLabel = market === 'CN' ? '中國A股' : '台股';
  const cacheFileName = market === 'CN' ? 'backtest-candles-cn.json' : 'backtest-candles.json';
  const benchmarkSymbols = market === 'CN'
    ? ['600519.SS', '601318.SS', '000001.SZ']   // 茅台、平安、平安銀行
    : ['2330.TW', '2317.TW', '2454.TW'];         // 台積電、鴻海、聯發科

  console.log('═══════════════════════════════════════════════════');
  console.log(`  回測排序權重：共振 vs 高勝率進場（${marketLabel}）`);
  console.log(`  期間：${BACKTEST_START} ~ ${BACKTEST_END}`);
  console.log('═══════════════════════════════════════════════════\n');

  // Step 1: 嘗試載入快取（按市場分開快取）
  const cacheFile = path.join(CACHE_DIR, cacheFileName);
  console.log('📦 檢查本地快取...');
  let allCandles = loadCache(cacheFile);

  if (!allCandles) {
    // Step 2: 取股票池
    const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
    console.log('📋 取得股票池...');
    const stockList = await scanner.getStockList();
    console.log(`   共 ${stockList.length} 支股票\n`);

    // Step 3: Yahoo Finance 20 並發下載
    console.log('📊 用 Yahoo Finance 下載歷史數據（20 並發）...');
    allCandles = new Map();
    let fetchCount = 0;
    let failCount = 0;

    const BATCH = 20;
    for (let i = 0; i < stockList.length; i += BATCH) {
      const batch = stockList.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (s) => {
          const candles = await fetchYahooCandles(s.symbol);
          return { symbol: s.symbol, name: s.name, candles };
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          allCandles.set(r.value.symbol, { candles: r.value.candles, name: r.value.name });
          fetchCount++;
        } else {
          failCount++;
        }
      }
      if ((i + BATCH) % 100 === 0 || i + BATCH >= stockList.length) {
        console.log(`   ${Math.min(i + BATCH, stockList.length)}/${stockList.length} (成功 ${fetchCount}, 失敗 ${failCount})`);
      }
    }
    console.log(`\n   ✅ 共取得 ${fetchCount} 支股票的歷史數據\n`);

    // Step 4: 存快取
    saveCache(allCandles, cacheFile);
  }

  // Step 5: 取得交易日清單
  const benchmarkCandidates = benchmarkSymbols;
  let benchmarkCandles: CandleWithIndicators[] | undefined;
  for (const sym of benchmarkCandidates) {
    benchmarkCandles = allCandles.get(sym)?.candles;
    if (benchmarkCandles && benchmarkCandles.length > 100) break;
  }
  if (!benchmarkCandles) {
    console.error('❌ 無法取得基準股票數據，無法確定交易日');
    return;
  }
  const tradingDays = getTradingDays(benchmarkCandles);
  console.log(`📅 回測期間共 ${tradingDays.length} 個交易日\n`);

  // Step 6: 逐日模擬
  const dayResults: DayResult[] = [];
  let processedDays = 0;

  for (const date of tradingDays) {
    const candidates: Array<{
      symbol: string;
      name: string;
      candleIdx: number;
      candles: CandleWithIndicators[];
      resonanceScore: number;
      highWinRateScore: number;
    }> = [];

    for (const [symbol, data] of allCandles) {
      const idx = findDateIndex(data.candles, date);
      if (idx < 30) continue;

      const candleDate = data.candles[idx].date?.slice(0, 10);
      if (candleDate !== date) continue;

      const result = evaluateStock(data.candles, idx);
      if (!result) continue;

      candidates.push({
        symbol,
        name: data.name,
        candleIdx: idx,
        candles: data.candles,
        resonanceScore: result.resonanceScore,
        highWinRateScore: result.highWinRateScore,
      });
    }

    // 6 種權重各取第 1 名
    const picks: DayResult['picks'] = {};
    for (const combo of WEIGHT_COMBOS) {
      if (candidates.length === 0) {
        picks[combo.name] = null;
        continue;
      }

      const sorted = [...candidates].sort((a, b) => {
        const scoreA = a.resonanceScore * combo.rW + a.highWinRateScore * combo.hW;
        const scoreB = b.resonanceScore * combo.rW + b.highWinRateScore * combo.hW;
        return scoreB - scoreA;
      });

      const top = sorted[0];
      const score = top.resonanceScore * combo.rW + top.highWinRateScore * combo.hW;

      const pick: PickResult = {
        symbol: top.symbol,
        name: top.name,
        score,
        resonance: top.resonanceScore,
        highWinRate: top.highWinRateScore,
      };
      for (const d of FORWARD_DAYS) {
        pick[`ret${d}d`] = forwardReturn(top.candles, top.candleIdx, d);
      }
      picks[combo.name] = pick;
    }

    dayResults.push({ date, candidateCount: candidates.length, picks });
    processedDays++;

    if (processedDays % 20 === 0) {
      console.log(`   處理進度：${processedDays}/${tradingDays.length} 天`);
    }
  }

  console.log(`\n✅ 完成 ${dayResults.length} 天回測\n`);

  // Step 7: 統計結果
  console.log('═══════════════════════════════════════════════════');
  console.log('  統計結果');
  console.log('═══════════════════════════════════════════════════\n');

  for (const combo of WEIGHT_COMBOS) {
    const picks = dayResults
      .map(d => d.picks[combo.name])
      .filter((p): p is NonNullable<typeof p> => p != null);

    const total = picks.length;
    if (total === 0) {
      console.log(`${combo.name}: 無交易\n`);
      continue;
    }

    const stats = (days: number) => {
      const key = `ret${days}d` as `ret${number}d`;
      const vals = picks.map(p => p[key]).filter((v): v is number => v != null);
      if (vals.length === 0) return { avg: 0, winRate: 0, count: 0 };
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const wins = vals.filter(v => v > 0).length;
      return { avg: +avg.toFixed(2), winRate: +((wins / vals.length) * 100).toFixed(1), count: vals.length };
    };

    console.log(`📊 ${combo.name}`);
    console.log(`   交易次數: ${total}`);
    for (const d of FORWARD_DAYS) {
      const s = stats(d);
      const label = `${d}日`.padEnd(4);
      console.log(`   ${label} — 平均報酬: ${s.avg > 0 ? '+' : ''}${s.avg}%  勝率: ${s.winRate}%  (${s.count}筆)`);
    }
    console.log('');
  }

  // 找出最佳組合（按每個天期分別排名）
  console.log('═══════════════════════════════════════════════════');
  console.log('  各天期最佳組合排名');
  console.log('═══════════════════════════════════════════════════\n');

  for (const d of FORWARD_DAYS) {
    const ranked = WEIGHT_COMBOS.map(combo => {
      const picks = dayResults
        .map(dr => dr.picks[combo.name])
        .filter((p): p is NonNullable<typeof p> => p != null);
      const key = `ret${d}d` as `ret${number}d`;
      const rets = picks.map(p => p[key]).filter((v): v is number => v != null);
      const avg = rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
      const wins = rets.filter(v => v > 0).length;
      return { name: combo.name, avg: +avg.toFixed(2), winRate: rets.length > 0 ? +((wins / rets.length) * 100).toFixed(1) : 0 };
    }).sort((a, b) => b.avg - a.avg);

    console.log(`  📅 ${d}日報酬排名:`);
    ranked.forEach((r, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
      console.log(`    ${medal} ${i + 1}. ${r.name}  均報: ${r.avg > 0 ? '+' : ''}${r.avg}%  勝率: ${r.winRate}%`);
    });
    console.log('');
  }
}

main().catch(console.error);
