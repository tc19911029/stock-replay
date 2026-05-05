/**
 * Mini scan：跑 30 支台股 + 30 支陸股完整六條件 + B-I 買法 + 戒律 + 淘汰
 * 看實際 production scan 是否乾淨運作，沒有異常
 *
 * 用法：npx tsx scripts/verify-mini-scan.ts
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { evaluateSixConditions, detectTrend } from '../lib/analysis/trendAnalysis';
import { checkLongProhibitions } from '../lib/rules/entryProhibitions';
import { evaluateElimination } from '../lib/scanner/eliminationFilter';
import { evaluateHighWinRateEntry } from '../lib/analysis/highWinRateEntry';
import { evaluateWinnerPatterns } from '../lib/rules/winnerPatternRules';
import { ruleEngine } from '../lib/rules/ruleEngine';
import { ZHU_PURE_BOOK } from '../lib/strategy/StrategyConfig';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { computeIndicators } from '../lib/indicators';
import { detectBreakoutEntry, detectConsolidationBreakout } from '../lib/analysis/breakoutEntry';
import { detectStrategyE } from '../lib/analysis/highWinRateEntry';
import { detectStrategyD } from '../lib/analysis/gapEntry';
import { detectVReversal } from '../lib/analysis/vReversalDetector';
import { detectABCBreakout } from '../lib/analysis/abcBreakoutEntry';
import { detectBlackKBreakout } from '../lib/analysis/blackKBreakoutEntry';
import { detectKlineConsolidationBreakout } from '../lib/analysis/klineConsolidationBreakout';

const TW_STOCKS = [
  '2330.TW', '2454.TW', '2317.TW', '2382.TW', '2308.TW',
  '3711.TW', '2303.TW', '2891.TW', '2882.TW', '2886.TW',
  '2412.TW', '3045.TW', '2884.TW', '2881.TW', '2885.TW',
  '2002.TW', '2881.TW', '2912.TW', '2880.TW', '2887.TW',
  '1303.TW', '1301.TW', '2207.TW', '3008.TW', '2357.TW',
  '2474.TW', '3702.TW', '2603.TW', '2615.TW', '6505.TW',
];

const CN_STOCKS = [
  '600519.SS', '601318.SS', '600036.SS', '601012.SS', '601398.SS',
  '600276.SS', '600900.SS', '601628.SS', '600030.SS', '601166.SS',
  '601888.SS', '600837.SS', '600000.SS', '601288.SS', '601988.SS',
  '600585.SS', '600028.SS', '600438.SS', '601857.SS', '600009.SS',
  '000001.SZ', '000002.SZ', '000333.SZ', '000651.SZ', '000725.SZ',
  '300750.SZ', '300059.SZ', '300015.SZ', '002594.SZ', '002415.SZ',
];

interface ScanRow {
  symbol: string;
  status: 'ok' | 'noData' | 'tooFew' | 'error';
  trend: string;
  six: number;
  isCoreReady: boolean;
  prohibited: boolean;
  eliminated: boolean;
  matchedMethods: string[];
  totalRules: number;
  highWinTags: number;
  winnerBullish: number;
  winnerBearish: number;
  errorMsg?: string;
}

async function scanOne(symbol: string, market: 'TW' | 'CN'): Promise<ScanRow> {
  const base: ScanRow = {
    symbol, status: 'ok', trend: '', six: 0, isCoreReady: false,
    prohibited: false, eliminated: false, matchedMethods: [],
    totalRules: 0, highWinTags: 0, winnerBullish: 0, winnerBearish: 0,
  };
  try {
    const file = await readCandleFile(symbol, market);
    if (!file || !file.candles) return { ...base, status: 'noData' };
    if (file.candles.length < 100) return { ...base, status: 'tooFew' };
    const candles = computeIndicators(file.candles);
    const idx = candles.length - 1;

    const six = evaluateSixConditions(candles, idx, ZHU_PURE_BOOK.thresholds);
    const trend = detectTrend(candles, idx);
    const prohib = checkLongProhibitions(candles, idx);
    const elim = evaluateElimination(candles, idx);
    const hwre = evaluateHighWinRateEntry(candles, idx);
    const wp = evaluateWinnerPatterns(candles, idx);
    const signals = ruleEngine.evaluate(candles, idx);

    const matchedMethods: string[] = [];
    if (six.isCoreReady) matchedMethods.push('A');
    try { if (detectBreakoutEntry(candles, idx)?.isBreakout) matchedMethods.push('B'); } catch {}
    try { if (detectConsolidationBreakout(candles, idx)?.isBreakout) matchedMethods.push('C'); } catch {}
    try { if (detectStrategyE(candles, idx)) matchedMethods.push('D'); } catch {}
    try { if (detectStrategyD(candles, idx)?.isGapEntry) matchedMethods.push('E'); } catch {}
    try { if (detectVReversal(candles, idx)?.isVReversal) matchedMethods.push('F'); } catch {}
    try { if (detectABCBreakout(candles, idx)?.isABCBreakout) matchedMethods.push('G'); } catch {}
    try { if (detectBlackKBreakout(candles, idx)?.isBlackKBreakout) matchedMethods.push('H'); } catch {}
    try { if (detectKlineConsolidationBreakout(candles, idx)?.isBreakout) matchedMethods.push('I'); } catch {}

    return {
      ...base,
      trend,
      six: six.totalScore,
      isCoreReady: six.isCoreReady,
      prohibited: prohib.prohibited,
      eliminated: elim.eliminated,
      matchedMethods,
      totalRules: signals.length,
      highWinTags: hwre.types.length,
      winnerBullish: wp.bullishPatterns.length,
      winnerBearish: wp.bearishPatterns.length,
    };
  } catch (err) {
    return { ...base, status: 'error', errorMsg: err instanceof Error ? err.message : String(err) };
  }
}

async function runMarket(market: 'TW' | 'CN', symbols: string[]): Promise<ScanRow[]> {
  console.log(`\n=== ${market} 市場掃描（${symbols.length} 支）===`);
  const start = Date.now();
  const rows = await Promise.all(symbols.map(s => scanOne(s, market)));
  const elapsed = Date.now() - start;
  console.log(`耗時：${elapsed}ms（平均 ${(elapsed / symbols.length).toFixed(0)}ms/股）`);
  return rows;
}

function summary(market: string, rows: ScanRow[]) {
  const ok = rows.filter(r => r.status === 'ok');
  const noData = rows.filter(r => r.status === 'noData').length;
  const tooFew = rows.filter(r => r.status === 'tooFew').length;
  const errors = rows.filter(r => r.status === 'error');

  console.log(`\n${market} 摘要：`);
  console.log(`  OK ${ok.length} / 無資料 ${noData} / 資料不足 ${tooFew} / 錯誤 ${errors.length}`);
  if (errors.length > 0) {
    console.log(`  錯誤樣本：`);
    errors.slice(0, 3).forEach(e => console.log(`    ${e.symbol}: ${e.errorMsg}`));
  }

  const byTrend: Record<string, number> = {};
  let coreReady = 0, prohibited = 0, eliminated = 0;
  let totalSignals = 0, totalHwt = 0, totalBull = 0, totalBear = 0;
  const methodHits: Record<string, number> = { A:0, B:0, C:0, D:0, E:0, F:0, G:0, H:0, I:0 };
  for (const r of ok) {
    byTrend[r.trend] = (byTrend[r.trend] ?? 0) + 1;
    if (r.isCoreReady) coreReady++;
    if (r.prohibited) prohibited++;
    if (r.eliminated) eliminated++;
    totalSignals += r.totalRules;
    totalHwt += r.highWinTags;
    totalBull += r.winnerBullish;
    totalBear += r.winnerBearish;
    for (const m of r.matchedMethods) methodHits[m]++;
  }
  console.log(`  趨勢分布：`, byTrend);
  console.log(`  isCoreReady: ${coreReady} 支 / 戒律違反: ${prohibited} 支 / 淘汰: ${eliminated} 支`);
  console.log(`  平均觸發規則: ${(totalSignals / ok.length).toFixed(1)} 條/股`);
  console.log(`  平均 highWinTags: ${(totalHwt / ok.length).toFixed(2)} / 股`);
  console.log(`  平均贏家圖像: 多 ${(totalBull / ok.length).toFixed(2)} / 空 ${(totalBear / ok.length).toFixed(2)}`);
  console.log(`  買法命中：A=${methodHits.A} B=${methodHits.B} C=${methodHits.C} D=${methodHits.D} E=${methodHits.E} F=${methodHits.F} G=${methodHits.G} H=${methodHits.H} I=${methodHits.I}`);

  // 列出有 isCoreReady 的股票
  const buyCandidates = ok.filter(r => r.isCoreReady && !r.prohibited && !r.eliminated);
  if (buyCandidates.length > 0) {
    console.log(`\n  ${market} 進場候選（六條件過 + 戒律不擋 + 不淘汰）：`);
    for (const c of buyCandidates) {
      console.log(`    ${c.symbol}: 六${c.six}/6 趨勢=${c.trend} 命中=[${c.matchedMethods.join(',')}] HWT=${c.highWinTags} Win=${c.winnerBullish}/${c.winnerBearish}`);
    }
  }
}

async function main() {
  console.log('═══ Mini Scan：30 TW + 30 CN ═══');
  const twRows = await runMarket('TW', TW_STOCKS);
  const cnRows = await runMarket('CN', CN_STOCKS);

  summary('TW', twRows);
  summary('CN', cnRows);

  console.log('\n═══ 完成 ═══');
}

main().catch(err => {
  console.error('腳本失敗:', err);
  process.exit(1);
});
