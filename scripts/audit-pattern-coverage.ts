/**
 * Pattern detection coverage audit
 *
 * 對 TW 全市場跑 detectLetterN（8 種底部）+ detectTopPatterns（3 種頂部），
 * 統計每種型態命中數 + 列出哪幾種完全沒命中。
 *
 * Usage: npx tsx scripts/audit-pattern-coverage.ts [TW|CN] [date]
 */

import path from 'path';
import { promises as fs } from 'fs';

import { detectLetterN, detectTopPatterns } from '../lib/analysis/v12LetterN';
import { computeIndicators } from '../lib/indicators';
import type { Candle, CandleWithIndicators } from '../types';

async function main() {
  const market = (process.argv[2] || 'TW') as 'TW' | 'CN';
  const asOfDate = process.argv[3] || '2026-05-08';

  const candleDir = path.join(process.cwd(), 'data', 'candles', market);
  let files: string[] = [];
  try {
    files = (await fs.readdir(candleDir)).filter(f => f.endsWith('.json'));
  } catch {
    console.error(`no candles dir at ${candleDir}`);
    return;
  }

  console.log(`audit ${market} ${asOfDate} — ${files.length} symbols`);

  const bottomCounts: Record<string, number> = {};
  const topCounts: Record<string, number> = {};
  const examples: Record<string, string[]> = {};
  let totalProcessed = 0;
  let bottomTriggered = 0;
  let topTriggered = 0;

  for (const f of files) {
    try {
      const raw = await fs.readFile(path.join(candleDir, f), 'utf-8');
      const parsed = JSON.parse(raw);
      // 檔案結構：{ symbol, lastDate, updatedAt, candles: Candle[] }
      const candles: Candle[] = Array.isArray(parsed) ? parsed : (parsed.candles || []);
      const idx = candles.findIndex(c => c.date === asOfDate);
      if (idx < 0 || idx < 30) continue;
      const sliced = candles.slice(0, idx + 1);
      const withInd: CandleWithIndicators[] = computeIndicators(sliced);
      const lastIdx = withInd.length - 1;
      totalProcessed++;
      const symbol = f.replace('.json', '');

      // 底部
      const n = detectLetterN(withInd, lastIdx, market, symbol);
      if (n.triggered && n.patternType) {
        bottomCounts[n.patternType] = (bottomCounts[n.patternType] || 0) + 1;
        bottomTriggered++;
        if (!examples[n.patternType]) examples[n.patternType] = [];
        if (examples[n.patternType].length < 3) examples[n.patternType].push(symbol);
      }

      // 頂部
      const t = detectTopPatterns(withInd, lastIdx);
      if (t.triggered && t.patternType) {
        topCounts[t.patternType] = (topCounts[t.patternType] || 0) + 1;
        topTriggered++;
        if (!examples[t.patternType]) examples[t.patternType] = [];
        if (examples[t.patternType].length < 3) examples[t.patternType].push(symbol);
      }
    } catch {
      // skip
    }
  }

  console.log(`\nprocessed ${totalProcessed} symbols`);
  console.log(`bottom triggered: ${bottomTriggered} | top triggered: ${topTriggered}`);

  const ALL_BOTTOM = ['head-shoulder', 'complex-head-shoulder', 'triple-bottom', 'falling-diamond', 'rounding-bottom', 'descending-wedge', 'double-bottom', 'n-shape'];
  const ALL_TOP = ['head-shoulder-top', 'triple-top', 'double-top'];

  console.log('\n底部型態（detectLetterN）:');
  for (const p of ALL_BOTTOM) {
    const c = bottomCounts[p] || 0;
    const ex = (examples[p] || []).join(', ');
    const flag = c === 0 ? '⚠️ ZERO' : '✓';
    console.log(`  ${flag} ${p.padEnd(25)} ${String(c).padStart(4)} ${ex ? `(e.g. ${ex})` : ''}`);
  }

  console.log('\n頂部型態（detectTopPatterns）:');
  for (const p of ALL_TOP) {
    const c = topCounts[p] || 0;
    const ex = (examples[p] || []).join(', ');
    const flag = c === 0 ? '⚠️ ZERO' : '✓';
    console.log(`  ${flag} ${p.padEnd(25)} ${String(c).padStart(4)} ${ex ? `(e.g. ${ex})` : ''}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
