/**
 * 個股型態探針 — 印出每個 detector 對單一股票的回應
 * Usage: npx tsx scripts/probe-pattern.ts <SYMBOL> [date]
 */

import path from 'path';
import { promises as fs } from 'fs';
import { detectLetterN, detectTopPatterns } from '../lib/analysis/v12LetterN';
import { findPivots } from '../lib/analysis/trendAnalysis';
import { computeIndicators } from '../lib/indicators';
import type { Candle, CandleWithIndicators } from '../types';

async function main() {
  const symbol = process.argv[2];
  const asOfDate = process.argv[3] || '2026-05-08';
  if (!symbol) { console.error('usage: probe-pattern <SYMBOL> [date]'); return; }

  const market: 'TW' | 'CN' = /\.(SS|SZ)$/.test(symbol) ? 'CN' : 'TW';
  const file = path.join(process.cwd(), 'data', 'candles', market, `${symbol}.json`);
  const raw = await fs.readFile(file, 'utf-8');
  const parsed = JSON.parse(raw);
  const candles: Candle[] = Array.isArray(parsed) ? parsed : (parsed.candles || []);

  const idx = candles.findIndex(c => c.date === asOfDate);
  if (idx < 0) { console.error(`date ${asOfDate} not found`); return; }
  const sliced = candles.slice(0, idx + 1);
  const withInd: CandleWithIndicators[] = computeIndicators(sliced);
  const lastIdx = withInd.length - 1;
  const last = withInd[lastIdx];

  console.log(`${symbol} ${asOfDate} O=${last.open} H=${last.high} L=${last.low} C=${last.close} V=${last.volume}`);
  console.log(`MA5=${last.ma5?.toFixed(2)} MA10=${last.ma10?.toFixed(2)} MA20=${last.ma20?.toFixed(2)}`);

  // pivots
  const pivots = findPivots(withInd, lastIdx, 10, false, 0.005);
  console.log(`\npivots (newest first):`);
  for (const p of pivots) {
    console.log(`  ${p.type === 'high' ? '頭' : '底'} idx=${p.index} price=${p.price.toFixed(2)} date=${withInd[p.index].date}`);
  }

  // 跑 detectLetterN
  const n = detectLetterN(withInd, lastIdx, market, symbol);
  console.log(`\ndetectLetterN: triggered=${n.triggered}`);
  if (n.triggered) {
    console.log(`  patternType: ${n.patternType}`);
    console.log(`  achievement: ${n.achievementRate}%`);
    console.log(`  neckline: ${n.necklinePrice}`);
    console.log(`  target: ${n.patternTargetPrice}`);
  }
  console.log(`  detail: ${n.detail}`);

  // 跑 detectTopPatterns
  const t = detectTopPatterns(withInd, lastIdx);
  console.log(`\ndetectTopPatterns: triggered=${t.triggered}`);
  if (t.triggered) {
    console.log(`  patternType: ${t.patternType}`);
    console.log(`  neckline: ${t.necklinePrice}`);
    console.log(`  target: ${t.patternTargetPrice}`);
  }
  console.log(`  detail: ${t.detail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
