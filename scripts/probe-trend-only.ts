import { loadLocalCandlesForDate } from '../lib/datasource/LocalCandleStore';
import { detectTrend, evaluateSixConditions } from '../lib/analysis/trendAnalysis';

async function main() {
  const candles = await loadLocalCandlesForDate('4749.TWO', 'TW', '2026-05-08');
  if (!candles) { console.log('no candles'); return; }
  const idx = candles.findIndex(c => c.date === '2026-05-08');
  console.log('lastIdx:', idx, 'total:', candles.length);
  console.log('last 3 dates:', candles.slice(-3).map(c => `${c.date}:${c.close}`));
  console.log('detectTrend(idx):', detectTrend(candles, idx));
  // 用 lastIdx-1 試試
  console.log('detectTrend(idx-1):', detectTrend(candles, idx-1));
  // sixCond with default thresholds (Q letter writer pattern)
  const sc1 = evaluateSixConditions(candles, idx);
  console.log('evalSix(idx, default):', sc1.trend.state, 'trendPass:', sc1.trend.pass, 'score:', sc1.totalScore);
  // sixCond with BASE_THRESHOLDS
  const { BASE_THRESHOLDS } = await import('../lib/strategy/StrategyConfig');
  const sc2 = evaluateSixConditions(candles, idx, BASE_THRESHOLDS);
  console.log('evalSix(idx, BASE):', sc2.trend.state, 'trendPass:', sc2.trend.pass, 'score:', sc2.totalScore);
}
main().catch(e => console.error(e));
