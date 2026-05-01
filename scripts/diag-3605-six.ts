import { promises as fs } from 'fs';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';

async function main() {
  const raw = await fs.readFile('data/candles/TW/3605.TW.json', 'utf8');
  const data = JSON.parse(raw);
  const upTo0421 = data.candles.filter((c: { date: string }) => c.date <= '2026-04-21');
  const enriched = computeIndicators(upTo0421);
  const idx = enriched.length - 1;

  const r = evaluateSixConditions(enriched, idx);

  console.log('=== 3605.TW @ 2026-04-21 六大條件評分 ===\n');
  console.log(`① 趨勢:    ${r.trend.pass ? '✅' : '❌'} ${r.trend.detail}`);
  console.log(`② 均線:    ${r.ma.pass ? '✅' : '❌'} ${r.ma.detail}`);
  console.log(`③ 股價位置: ${r.position.pass ? '✅' : '❌'} ${r.position.detail}`);
  console.log(`④ 成交量:  ${r.volume.pass ? '✅' : '❌'} ${r.volume.detail}`);
  console.log(`⑤ K線:    ${r.kbar.pass ? '✅' : '❌'} ${r.kbar.detail}`);
  console.log(`⑥ 指標:    ${r.indicator.pass ? '✅' : '❌'} ${r.indicator.detail}`);
  console.log(`\n核心 5 條件 score = ${r.coreScore}/5`);
  console.log(`isCoreReady (= A 標籤) = ${r.isCoreReady ? '✅ 是' : '❌ 否'}`);
  console.log(`總分 totalScore = ${r.totalScore}/6`);
  console.log(`高勝率 tags = ${JSON.stringify(r.highWinTags)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
