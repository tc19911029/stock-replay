/**
 * 顯示最近 N 天的每日選股明細
 * Usage:
 *   npx tsx scripts/show-recent-picks.ts              # 台股最近22天
 *   npx tsx scripts/show-recent-picks.ts --market CN  # 陸股最近22天
 *   npx tsx scripts/show-recent-picks.ts --days 10    # 最近10天
 */
import fs from 'fs';
import path from 'path';
import { computeIndicators } from '../lib/indicators';
import { evaluateSixConditions } from '../lib/analysis/trendAnalysis';
import { checkLongProhibitions } from '../lib/rules/entryProhibitions';
import { evaluateElimination } from '../lib/scanner/eliminationFilter';
import { evaluateHighWinRateEntry } from '../lib/analysis/highWinRateEntry';
import { ruleEngine } from '../lib/rules/ruleEngine';
import { ZHU_V1 } from '../lib/strategy/StrategyConfig';
import type { CandleWithIndicators, Candle } from '../types';

const thresholds = ZHU_V1.thresholds;

const WEIGHT_COMBOS = [
  { name: 'A:共振100%',  rW: 1.0, hW: 0.0 },
  { name: 'B:80/20',     rW: 0.8, hW: 0.2 },
  { name: 'C:70/30',     rW: 0.7, hW: 0.3 },
  { name: 'D:50/50',     rW: 0.5, hW: 0.5 },
  { name: 'E:30/70',     rW: 0.3, hW: 0.7 },
  { name: 'F:高勝100%',  rW: 0.0, hW: 1.0 },
];

// ── Parse args ──
const args = process.argv.slice(2);
const marketIdx = args.indexOf('--market');
const market = marketIdx >= 0 ? (args[marketIdx + 1] ?? 'TW') : 'TW';
const daysIdx = args.indexOf('--days');
const SHOW_DAYS = daysIdx >= 0 ? parseInt(args[daysIdx + 1] ?? '22', 10) : 22;

const cacheFile = path.join(process.cwd(), 'data',
  market === 'CN' ? 'backtest-candles-cn.json' : 'backtest-candles.json');

interface CacheData {
  savedAt: string;
  stocks: Record<string, { name: string; candles: Candle[] }>;
}

function findDateIndex(candles: CandleWithIndicators[], targetDate: string): number {
  for (let i = candles.length - 1; i >= 0; i--) {
    const d = candles[i].date?.slice(0, 10);
    if (d && d <= targetDate) return i;
  }
  return -1;
}

function evaluateStock(candles: CandleWithIndicators[], lastIdx: number) {
  if (lastIdx < 30) return null;
  const last = candles[lastIdx];

  const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
  if (!sixConds.isCoreReady) return null;

  if (last.kdK != null && lastIdx > 0) {
    const prevKdK = candles[lastIdx - 1]?.kdK;
    if (prevKdK != null && last.kdK < prevKdK) return null;
  }

  const dayRange = last.high - last.low;
  const upperShadow = last.high - last.close;
  if (dayRange > 0 && upperShadow / dayRange > 0.5) return null;

  const prohib = checkLongProhibitions(candles, lastIdx);
  if (prohib.prohibited) return null;

  const elimination = evaluateElimination(candles, lastIdx);
  if (elimination.eliminated) return null;

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
  } catch {}

  return { resonanceScore, highWinRateScore };
}

function forwardReturn(candles: CandleWithIndicators[], idx: number, days: number): number | null {
  const exit = idx + days;
  if (exit >= candles.length) return null;
  const entry = candles[idx].close;
  if (!entry || entry <= 0) return null;
  return +((candles[exit].close - entry) / entry * 100).toFixed(2);
}

async function main() {
  const label = market === 'CN' ? '陸股' : '台股';
  console.log(`\n═══ ${label}最近 ${SHOW_DAYS} 個交易日選股明細 ═══\n`);

  if (!fs.existsSync(cacheFile)) {
    console.error(`❌ 找不到快取 ${cacheFile}，請先跑 backtest-ranking-weights.ts`);
    return;
  }

  const raw: CacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  console.log(`📦 載入快取（${raw.savedAt}）`);

  const allCandles = new Map<string, { candles: CandleWithIndicators[]; name: string }>();
  for (const [symbol, data] of Object.entries(raw.stocks)) {
    if (data.candles.length >= 60) {
      allCandles.set(symbol, { candles: computeIndicators(data.candles), name: data.name });
    }
  }
  console.log(`   ${allCandles.size} 支股票\n`);

  // 取交易日
  const benchmarks = market === 'CN'
    ? ['600519.SS', '601318.SS', '000001.SZ']
    : ['2330.TW', '2317.TW', '2454.TW'];
  let benchCandles: CandleWithIndicators[] | undefined;
  for (const s of benchmarks) {
    benchCandles = allCandles.get(s)?.candles;
    if (benchCandles && benchCandles.length > 100) break;
  }
  if (!benchCandles) { console.error('❌ 找不到基準股'); return; }

  const allDays = benchCandles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d);
  const recentDays = allDays.slice(-SHOW_DAYS);

  for (const date of recentDays) {
    // 收集候選股
    const candidates: Array<{
      symbol: string; name: string; price: number; change: number;
      candleIdx: number; candles: CandleWithIndicators[];
      resonanceScore: number; highWinRateScore: number;
    }> = [];

    for (const [symbol, data] of allCandles) {
      const idx = findDateIndex(data.candles, date);
      if (idx < 30) continue;
      if (data.candles[idx].date?.slice(0, 10) !== date) continue;

      const result = evaluateStock(data.candles, idx);
      if (!result) continue;

      const last = data.candles[idx];
      const prev = data.candles[idx - 1];
      const change = prev?.close ? +((last.close - prev.close) / prev.close * 100).toFixed(2) : 0;

      candidates.push({
        symbol, name: data.name, price: last.close, change,
        candleIdx: idx, candles: data.candles,
        ...result,
      });
    }

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📅 ${date}  候選股: ${candidates.length} 支`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    if (candidates.length === 0) {
      console.log('   （當天無候選股）\n');
      continue;
    }

    for (const combo of WEIGHT_COMBOS) {
      const sorted = [...candidates].sort((a, b) => {
        const sa = a.resonanceScore * combo.rW + a.highWinRateScore * combo.hW;
        const sb = b.resonanceScore * combo.rW + b.highWinRateScore * combo.hW;
        return sb - sa;
      });
      const top = sorted[0];
      const score = +(top.resonanceScore * combo.rW + top.highWinRateScore * combo.hW).toFixed(1);

      const DAYS = [1, 2, 3, 4, 5, 10, 20];
      const rets = DAYS.map(d => forwardReturn(top.candles, top.candleIdx, d));

      const fmtR = (v: number | null) => v == null ? ' N/A' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
      const retStr = DAYS.map((d, i) => `${d}D:${fmtR(rets[i])}`).join(' ');

      console.log(
        `   ${combo.name.padEnd(12)} → ${top.symbol} ${top.name.padEnd(6)} ` +
        `$${top.price}  共振${top.resonanceScore} 高勝${top.highWinRateScore}  ` +
        retStr
      );
    }
    console.log('');
  }
}

main().catch(console.error);
