/**
 * 大漲股特性分析
 *
 * 從 MTF≥3 + Layer 1-3 篩出的候選股中，
 * 找出 5 日後漲幅最大的股票，分析它們在選出當天的技術特徵，
 * 與普通股/下跌股比較，反推排序因子。
 *
 * Usage: npx tsx scripts/analyze-winner-traits.ts
 */

import fs from 'fs';
import path from 'path';
import { loadAndPrepare } from '../lib/backtest/optimizer/candidateCollector';
import type { CacheData } from '../lib/backtest/optimizer/candidateCollector';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { evaluateMultiTimeframe } from '@/lib/analysis/multiTimeframeFilter';
import { checkLongProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { evaluateHighWinRateEntry } from '@/lib/analysis/highWinRateEntry';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import type { CandleWithIndicators } from '@/types';

const BACKTEST_START = '2021-06-01';
const BACKTEST_END   = '2026-04-04';
const MTF_THRESHOLD  = 3;

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles.json');

interface CandidateFeatures {
  date: string;
  symbol: string;
  name: string;
  day5Return: number;

  // 排序因子
  highWinRateScore: number;
  mtfScore: number;
  sixCondScore: number;

  // 價格位置
  priceVsMa5: number;     // 收盤價/MA5 -1 (%)
  priceVsMa10: number;
  priceVsMa20: number;
  priceVsMa60: number;
  distFrom20dHigh: number; // 離 20 日高點的距離 (%)
  distFrom60dHigh: number; // 離 60 日高點的距離 (%)

  // 量能
  volRatio: number;        // 當日成交量 / 5 日均量
  vol5vs20: number;        // 5 日均量 / 20 日均量

  // 動能
  mom1d: number;           // 1 日漲跌幅 (%)
  mom3d: number;           // 3 日累積漲幅 (%)
  mom5d: number;           // 5 日累積漲幅 (%)
  mom10d: number;          // 10 日累積漲幅 (%)

  // K 線形態
  bodyRatio: number;       // 實體/全幅 (%)
  upperShadow: number;     // 上影線/全幅 (%)
  lowerShadow: number;     // 下影線/全幅 (%)
  isRedCandle: boolean;    // 紅 K

  // 技術指標
  rsi: number | null;
  kdK: number | null;
  kdD: number | null;
  macdHist: number | null;

  // 波動性
  atr5: number;            // 5 日平均真實波幅 (%)
}

function getMA(candles: CandleWithIndicators[], idx: number, period: number): number {
  let sum = 0;
  const start = Math.max(0, idx - period + 1);
  const count = idx - start + 1;
  for (let i = start; i <= idx; i++) sum += candles[i].close;
  return sum / count;
}

function getHighest(candles: CandleWithIndicators[], idx: number, period: number): number {
  let max = -Infinity;
  for (let i = Math.max(0, idx - period + 1); i <= idx; i++) {
    if (candles[i].high > max) max = candles[i].high;
  }
  return max;
}

function getAvgVolume(candles: CandleWithIndicators[], idx: number, period: number): number {
  let sum = 0;
  const start = Math.max(0, idx - period + 1);
  for (let i = start; i <= idx; i++) sum += (candles[i].volume ?? 0);
  return sum / (idx - start + 1);
}

function getATR(candles: CandleWithIndicators[], idx: number, period: number): number {
  let sum = 0;
  let count = 0;
  for (let i = Math.max(1, idx - period + 1); i <= idx; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    sum += tr / candles[i].close * 100;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  大漲股特性分析（MTF≥3 + Layer 1-3，台股 5 年）');
  console.log('  目標：找出 5 日漲幅最大的股票有什麼共同特徵');
  console.log('═══════════════════════════════════════════════════════════\n');

  const raw: CacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  const data = loadAndPrepare(raw, ['2330.TW', '2317.TW', '2454.TW'], 'TW', BACKTEST_START, BACKTEST_END);
  console.log(`   ${data.allCandles.size} 支股票，${data.tradingDays.length} 個交易日\n`);

  const features: CandidateFeatures[] = [];
  let dc = 0;

  for (const date of data.tradingDays) {
    dc++;
    if (dc % 100 === 0) console.log(`   進度：${dc}/${data.tradingDays.length}`);

    for (const [symbol, stockData] of data.allCandles) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 60 || idx >= candles.length - 5) continue;

      // Layer 1
      const sixConds = evaluateSixConditions(candles, idx);
      if (!sixConds.isCoreReady || sixConds.totalScore < ZHU_V1.thresholds.minScore) continue;

      // Layer 1b
      const kd = candles[idx].indicators?.kd;
      const prevKd = candles[idx - 1]?.indicators?.kd;
      if (kd && prevKd && kd.k < prevKd.k) continue;

      const c = candles[idx];
      const totalRange = c.high - c.low;
      if (totalRange > 0) {
        const us = c.high - Math.max(c.open, c.close);
        if (us / totalRange > 0.5) continue;
      }

      // Layer 2
      try { if (checkLongProhibitions(candles, idx).isProhibited) continue; } catch { continue; }

      // Layer 3
      try { if (evaluateElimination(candles, idx).isEliminated) continue; } catch { continue; }

      // MTF ≥ 3
      let mtfScore = 0;
      try { mtfScore = evaluateMultiTimeframe(candles, idx).totalScore; } catch {}
      if (mtfScore < MTF_THRESHOLD) continue;

      // 排序因子
      let highWinRateScore = 0;
      try { highWinRateScore = evaluateHighWinRateEntry(candles, idx).score; } catch {}

      // 5 日漲幅
      const entryPrice = c.close;
      const futureIdx = idx + 5;
      if (futureIdx >= candles.length) continue;
      const day5Return = +((candles[futureIdx].close - entryPrice) / entryPrice * 100).toFixed(2);

      // 特徵計算
      const ma5 = getMA(candles, idx, 5);
      const ma10 = getMA(candles, idx, 10);
      const ma20 = getMA(candles, idx, 20);
      const ma60 = getMA(candles, idx, 60);

      const bodySize = Math.abs(c.close - c.open);
      const upperShadow = totalRange > 0 ? (c.high - Math.max(c.open, c.close)) / totalRange * 100 : 0;
      const lowerShadow = totalRange > 0 ? (Math.min(c.open, c.close) - c.low) / totalRange * 100 : 0;
      const bodyRatio = totalRange > 0 ? bodySize / totalRange * 100 : 0;

      const vol = c.volume ?? 0;
      const avgVol5 = getAvgVolume(candles, idx, 5);
      const avgVol20 = getAvgVolume(candles, idx, 20);

      features.push({
        date, symbol, name: stockData.name, day5Return,
        highWinRateScore, mtfScore, sixCondScore: sixConds.totalScore,

        priceVsMa5:  +((c.close / ma5 - 1) * 100).toFixed(2),
        priceVsMa10: +((c.close / ma10 - 1) * 100).toFixed(2),
        priceVsMa20: +((c.close / ma20 - 1) * 100).toFixed(2),
        priceVsMa60: +((c.close / ma60 - 1) * 100).toFixed(2),
        distFrom20dHigh: +((c.close / getHighest(candles, idx, 20) - 1) * 100).toFixed(2),
        distFrom60dHigh: +((c.close / getHighest(candles, idx, 60) - 1) * 100).toFixed(2),

        volRatio:  +(avgVol5 > 0 ? vol / avgVol5 : 0).toFixed(2),
        vol5vs20:  +(avgVol20 > 0 ? avgVol5 / avgVol20 : 0).toFixed(2),

        mom1d:  +((c.close / candles[idx - 1].close - 1) * 100).toFixed(2),
        mom3d:  +((c.close / candles[idx - 3].close - 1) * 100).toFixed(2),
        mom5d:  +((c.close / candles[idx - 5].close - 1) * 100).toFixed(2),
        mom10d: +((c.close / candles[idx - 10].close - 1) * 100).toFixed(2),

        bodyRatio: +bodyRatio.toFixed(1),
        upperShadow: +upperShadow.toFixed(1),
        lowerShadow: +lowerShadow.toFixed(1),
        isRedCandle: c.close > c.open,

        rsi:      candles[idx].indicators?.rsi ?? null,
        kdK:      kd?.k ?? null,
        kdD:      kd?.d ?? null,
        macdHist: candles[idx].indicators?.macd?.histogram ?? null,

        atr5: +getATR(candles, idx, 5).toFixed(2),
      });
    }
  }

  console.log(`\n   MTF≥3 候選股: ${features.length} 筆\n`);

  // 分三組：大漲 (>10%), 普通 (-5%~5%), 大跌 (<-5%)
  const winners = features.filter(f => f.day5Return > 10).sort((a, b) => b.day5Return - a.day5Return);
  const normal  = features.filter(f => f.day5Return >= -5 && f.day5Return <= 5);
  const losers  = features.filter(f => f.day5Return < -5).sort((a, b) => a.day5Return - b.day5Return);

  console.log(`   大漲 (5日>10%): ${winners.length} 筆`);
  console.log(`   普通 (-5%~5%):  ${normal.length} 筆`);
  console.log(`   大跌 (5日<-5%): ${losers.length} 筆\n`);

  // 計算各組特徵平均值
  function groupAvg(group: CandidateFeatures[], key: keyof CandidateFeatures): string {
    const vals = group.map(f => f[key]).filter((v): v is number => typeof v === 'number' && !isNaN(v));
    if (vals.length === 0) return 'N/A';
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    return (avg >= 0 ? '+' : '') + avg.toFixed(2);
  }

  function groupPct(group: CandidateFeatures[], predicate: (f: CandidateFeatures) => boolean): string {
    return (group.filter(predicate).length / group.length * 100).toFixed(1) + '%';
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  特徵比較：大漲股 vs 普通股 vs 大跌股');
  console.log('═══════════════════════════════════════════════════════════\n');

  const traits: [string, keyof CandidateFeatures][] = [
    ['高勝率分數',     'highWinRateScore'],
    ['MTF 分數',       'mtfScore'],
    ['六條件分數',     'sixCondScore'],
    ['價格/MA5 (%)',   'priceVsMa5'],
    ['價格/MA10 (%)',  'priceVsMa10'],
    ['價格/MA20 (%)',  'priceVsMa20'],
    ['價格/MA60 (%)',  'priceVsMa60'],
    ['離20日高(%)',    'distFrom20dHigh'],
    ['離60日高(%)',    'distFrom60dHigh'],
    ['量比(日/5日均)', 'volRatio'],
    ['量能趨勢(5/20)', 'vol5vs20'],
    ['1日動能(%)',     'mom1d'],
    ['3日動能(%)',     'mom3d'],
    ['5日動能(%)',     'mom5d'],
    ['10日動能(%)',    'mom10d'],
    ['實體比(%)',      'bodyRatio'],
    ['上影線(%)',      'upperShadow'],
    ['下影線(%)',      'lowerShadow'],
    ['RSI',           'rsi'],
    ['KD-K',          'kdK'],
    ['KD-D',          'kdD'],
    ['MACD柱',        'macdHist'],
    ['ATR5(%)',        'atr5'],
  ];

  console.log('特徵'.padEnd(18) + '大漲(>10%)'.padStart(12) + '普通(-5~5%)'.padStart(12) + '大跌(<-5%)'.padStart(12) + '  差異方向');
  console.log('─'.repeat(70));

  for (const [label, key] of traits) {
    const w = groupAvg(winners, key);
    const n = groupAvg(normal, key);
    const l = groupAvg(losers, key);
    const wNum = parseFloat(w) || 0;
    const lNum = parseFloat(l) || 0;
    const diff = wNum > lNum ? '  ↑ 大漲較高' : wNum < lNum ? '  ↓ 大漲較低' : '';
    console.log(label.padEnd(18) + w.padStart(12) + n.padStart(12) + l.padStart(12) + diff);
  }

  // 紅 K 比例
  console.log('紅K比例'.padEnd(18) +
    groupPct(winners, f => f.isRedCandle).padStart(12) +
    groupPct(normal, f => f.isRedCandle).padStart(12) +
    groupPct(losers, f => f.isRedCandle).padStart(12));

  // 找出差異最大的特徵
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  差異最大的特徵（大漲 vs 大跌）');
  console.log('═══════════════════════════════════════════════════════════\n');

  const diffs: { label: string; wAvg: number; lAvg: number; diff: number }[] = [];
  for (const [label, key] of traits) {
    const wVals = winners.map(f => f[key]).filter((v): v is number => typeof v === 'number' && !isNaN(v));
    const lVals = losers.map(f => f[key]).filter((v): v is number => typeof v === 'number' && !isNaN(v));
    if (wVals.length === 0 || lVals.length === 0) continue;
    const wAvg = wVals.reduce((s, v) => s + v, 0) / wVals.length;
    const lAvg = lVals.reduce((s, v) => s + v, 0) / lVals.length;
    const nVals = normal.map(f => f[key]).filter((v): v is number => typeof v === 'number' && !isNaN(v));
    const nAvg = nVals.length > 0 ? nVals.reduce((s, v) => s + v, 0) / nVals.length : 0;
    // Normalize diff by normal group's std or range
    const range = Math.max(Math.abs(wAvg), Math.abs(lAvg), Math.abs(nAvg), 0.01);
    diffs.push({ label, wAvg, lAvg, diff: (wAvg - lAvg) / range });
  }

  diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  for (const d of diffs.slice(0, 10)) {
    const dir = d.wAvg > d.lAvg ? '大漲 > 大跌' : '大漲 < 大跌';
    console.log(`  ${d.label.padEnd(18)} 大漲=${d.wAvg.toFixed(2).padStart(8)}  大跌=${d.lAvg.toFixed(2).padStart(8)}  ${dir}`);
  }

  // Top 30 大漲股列表
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Top 30 大漲股（5日漲幅最大）');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('日期        股票         5日漲  高勝 MTF  量比  5日動能 價/MA20 ATR5');
  console.log('─'.repeat(80));
  for (const w of winners.slice(0, 30)) {
    console.log(
      w.date + ' ' +
      w.symbol.padEnd(12) +
      ('+' + w.day5Return.toFixed(1) + '%').padStart(7) +
      w.highWinRateScore.toString().padStart(5) +
      w.mtfScore.toString().padStart(4) +
      w.volRatio.toFixed(1).padStart(6) +
      ((w.mom5d >= 0 ? '+' : '') + w.mom5d.toFixed(1) + '%').padStart(8) +
      ((w.priceVsMa20 >= 0 ? '+' : '') + w.priceVsMa20.toFixed(1) + '%').padStart(8) +
      w.atr5.toFixed(1).padStart(5)
    );
  }

  // 建議新排序因子
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  排序因子建議');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Check which features best separate winners from losers
  const factorTests: { name: string; key: keyof CandidateFeatures; higher: boolean }[] = [
    { name: '高勝率分數', key: 'highWinRateScore', higher: true },
    { name: '量比', key: 'volRatio', higher: true },
    { name: '5日動能', key: 'mom5d', higher: true },
    { name: '10日動能', key: 'mom10d', higher: true },
    { name: '價格/MA20', key: 'priceVsMa20', higher: true },
    { name: 'ATR5', key: 'atr5', higher: true },
    { name: '實體比', key: 'bodyRatio', higher: true },
    { name: 'RSI', key: 'rsi', higher: true },
  ];

  console.log('因子'.padEnd(16) + '大漲均值'.padStart(10) + '大跌均值'.padStart(10) + '差異'.padStart(8) + '  能否區分');
  console.log('─'.repeat(55));

  for (const ft of factorTests) {
    const wVals = winners.map(f => f[ft.key]).filter((v): v is number => typeof v === 'number' && !isNaN(v));
    const lVals = losers.map(f => f[ft.key]).filter((v): v is number => typeof v === 'number' && !isNaN(v));
    if (wVals.length === 0 || lVals.length === 0) continue;
    const wAvg = wVals.reduce((s, v) => s + v, 0) / wVals.length;
    const lAvg = lVals.reduce((s, v) => s + v, 0) / lVals.length;
    const diff = wAvg - lAvg;
    const canDistinguish = ft.higher ? diff > 0 : diff < 0;
    console.log(
      ft.name.padEnd(16) +
      wAvg.toFixed(2).padStart(10) +
      lAvg.toFixed(2).padStart(10) +
      ((diff >= 0 ? '+' : '') + diff.toFixed(2)).padStart(8) +
      (canDistinguish ? '  ✅ 可用' : '  ❌ 無效')
    );
  }
}

main().catch(console.error);
