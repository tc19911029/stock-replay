/**
 * 用現在完整的 L1 資料，重跑 2026-04-21 TW daily 六條件 scan
 * 看 3605 應該不應該被選上
 */
import { promises as fs } from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';

const DATE = '2026-04-21';
const MIN_SCORE = 5;

async function main() {
  const dir = 'data/candles/TW';
  const files = await fs.readdir(dir);
  const targets = files.filter(f => f.endsWith('.json'));

  type Hit = {
    symbol: string;
    close: number;
    chgPct: number;
    coreScore: number;
    totalScore: number;
    isCoreReady: boolean;
    deviationMA20: number | null;
  };
  const hits: Hit[] = [];
  let scanned = 0, noData = 0;

  for (const f of targets) {
    const symbol = f.replace('.json', '');
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf8');
      const data = JSON.parse(raw);
      const candles = data.candles.filter((c: { date: string }) => c.date <= DATE);
      if (candles.length < 30) { noData++; continue; }
      const last = candles[candles.length - 1];
      if (last.date !== DATE) { noData++; continue; }
      const enriched = computeIndicators(candles);
      const idx = enriched.length - 1;
      const r = evaluateSixConditions(enriched, idx);
      scanned++;
      const lastBar = enriched[idx];
      const prev = enriched[idx - 1];
      const chgPct = prev ? ((lastBar.close - prev.close) / prev.close) * 100 : 0;
      if (r.totalScore >= MIN_SCORE) {
        hits.push({
          symbol,
          close: lastBar.close,
          chgPct,
          coreScore: r.coreScore,
          totalScore: r.totalScore,
          isCoreReady: r.isCoreReady,
          deviationMA20: r.position.deviation,
        });
      }
    } catch { noData++; }
  }

  hits.sort((a, b) => b.chgPct - a.chgPct);
  console.log(`=== 重跑 ${DATE} TW daily 六條件 (minScore≥${MIN_SCORE}) ===`);
  console.log(`掃描 ${scanned} 支，無資料 ${noData} 支，命中 ${hits.length} 支\n`);

  // 列出 3605 結果（不管命不命中）
  const h3605 = hits.find(h => h.symbol === '3605.TW');
  console.log('3605 (宏致):', h3605 ? `✅ 命中 score=${h3605.totalScore}/6 chg=${h3605.chgPct.toFixed(2)}%` : '✗ 未命中');

  console.log('\n命中前 30 支：');
  console.log(`${'symbol'.padEnd(10)} ${'close'.padStart(8)} ${'chg%'.padStart(7)} ${'score'.padStart(6)} ${'coreReady'.padStart(10)} ${'devMA20%'.padStart(9)}`);
  for (const h of hits.slice(0, 30)) {
    const star = h.symbol === '3605.TW' ? ' ★' : '';
    console.log(`${h.symbol.padEnd(10)} ${h.close.toFixed(2).padStart(8)} ${h.chgPct.toFixed(2).padStart(7)} ${h.totalScore.toString().padStart(6)} ${(h.isCoreReady ? '是' : '否').padStart(10)} ${(h.deviationMA20 ? (h.deviationMA20 * 100).toFixed(1) : '?').padStart(9)}${star}`);
  }

  // 看 3605 排名
  const rank = hits.findIndex(h => h.symbol === '3605.TW');
  if (rank >= 0) console.log(`\n 3605 排名第 ${rank + 1} / ${hits.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
