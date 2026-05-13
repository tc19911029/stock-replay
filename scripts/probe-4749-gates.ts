/**
 * Probe 4749 新應材 0508 為什麼被 daily writer 剔除
 *
 * Daily writer 在 MarketScanner.ts:464-491 有 5 道 gate：
 *   1. sixConds.isCoreReady（核心 5 條件）
 *   2. sixConds.totalScore < minScore
 *   3. KD 向下不買
 *   4. 戒律（prohibitions）
 *   5. 淘汰法（elimination）
 *
 * Letter writer 只查 #1（isCoreReady），所以 4749 在 B/J/Q session 有 'A' tag。
 * 找 4749 fail 哪一道。
 */
import { loadLocalCandlesForDate } from '../lib/datasource/LocalCandleStore';
import { evaluateSixConditions } from '../lib/analysis/trendAnalysis';
import { checkLongProhibitions } from '../lib/rules/entryProhibitions';
import { evaluateElimination } from '../lib/scanner/eliminationFilter';
import { BASE_THRESHOLDS } from '../lib/strategy/StrategyConfig';

async function main() {
  const symbol = '4749.TWO';
  const date = '2026-05-08';
  const market = 'TW' as const;

  const candles = await loadLocalCandlesForDate(symbol, market, date);
  if (!candles || candles.length === 0) {
    console.log('NO CANDLES for', symbol);
    return;
  }
  const lastIdx = candles.findIndex((c) => c.date === date);
  if (lastIdx < 0) {
    console.log(`${date} not in candles. Last 3 dates:`, candles.slice(-3).map((c) => c.date));
    return;
  }
  const last = candles[lastIdx];
  console.log(`Probing ${symbol} on ${date}, lastIdx=${lastIdx}/${candles.length - 1}`);
  console.log(`  close=${last.close} high=${last.high} low=${last.low} volume=${last.volume}`);
  console.log(`  KD K=${last.kdK} D=${last.kdD}, MACD osc=${last.macdOsc}\n`);

  const thresholds = BASE_THRESHOLDS;
  console.log('thresholds:', { minScore: thresholds.minScore, kdDecliningFilter: thresholds.kdDecliningFilter });

  const sc = evaluateSixConditions(candles, lastIdx, thresholds);
  console.log('\n[gate 1] sixConds.isCoreReady =', sc.isCoreReady);
  console.log('  totalScore =', sc.totalScore, '/ 6');
  console.log('  trend:', sc.trend.pass, 'detail:', sc.trend.detail);
  console.log('  position:', sc.position.pass, 'detail:', sc.position.detail);
  console.log('  kbar:', sc.kbar.pass, 'detail:', sc.kbar.detail);
  console.log('  ma:', sc.ma.pass, 'detail:', sc.ma.detail);
  console.log('  volume:', sc.volume.pass, 'detail:', sc.volume.detail);
  console.log('  indicator:', sc.indicator.pass, 'detail:', sc.indicator.detail);

  if (!sc.isCoreReady) { console.log('\n→ FAILED at gate 1 (isCoreReady)'); return; }
  console.log('\n[gate 2] minScore check:', sc.totalScore, '<', thresholds.minScore, '?', sc.totalScore < thresholds.minScore);
  if (sc.totalScore < thresholds.minScore) { console.log('→ FAILED at gate 2 (minScore)'); return; }

  const prevKdK = candles[lastIdx - 1]?.kdK;
  const kdDeclining = thresholds.kdDecliningFilter !== false && last.kdK != null && prevKdK != null && last.kdK < prevKdK;
  console.log('\n[gate 3] KD declining: today K=', last.kdK, 'vs yesterday K=', prevKdK, '→ declining?', kdDeclining);
  if (kdDeclining) { console.log('→ FAILED at gate 3 (KD declining)'); return; }

  const prohib = checkLongProhibitions(candles, lastIdx);
  console.log('\n[gate 4] prohibitions.prohibited =', prohib.prohibited);
  if (prohib.prohibited) {
    console.log('  reasons:', prohib.reasons);
    console.log('→ FAILED at gate 4 (prohibitions)');
    return;
  }

  const elim = evaluateElimination(candles, lastIdx);
  console.log('\n[gate 5] elimination.eliminated =', elim.eliminated);
  if (elim.eliminated) {
    console.log('  reasons:', elim.reasons);
    console.log('→ FAILED at gate 5 (elimination)');
    return;
  }

  console.log('\n→ ALL gates pass — 4749 should be in pool');
}

main().catch((err) => { console.error(err); process.exit(1); });
