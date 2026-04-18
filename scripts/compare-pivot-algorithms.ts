#!/usr/bin/env ts-node
/**
 * 對照書本 p.22 轉折波畫法 vs 現行 findPivots
 * 用 2345 智邦最近 60 根日 K
 */
import fs from 'node:fs';
import path from 'node:path';

interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function computeMA(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return out;
}

/** 書本 p.22：用 MA5 分正負價區，取段內 high/low 含影線 */
function findPivotsBook(candles: Candle[], ma5: (number | null)[]) {
  const pivots: { index: number; date: string; price: number; type: 'high' | 'low' }[] = [];
  let segStart = -1;
  let segType: 'positive' | 'negative' | null = null;

  for (let i = 0; i < candles.length; i++) {
    if (ma5[i] == null) continue;
    const isPositive = candles[i].close > ma5[i]!;
    const currType = isPositive ? 'positive' : 'negative';

    if (segType === null) {
      segType = currType;
      segStart = i;
      continue;
    }
    if (currType !== segType) {
      // 交界：把 segStart..i（含交界當天）取極值
      const segEnd = i; // include the crossing day
      const slice = candles.slice(segStart, segEnd + 1);
      if (segType === 'positive') {
        // 正價區結束 → 取 max(high)
        let maxHigh = -Infinity, maxIdx = segStart;
        for (let j = 0; j < slice.length; j++) {
          if (slice[j].high > maxHigh) { maxHigh = slice[j].high; maxIdx = segStart + j; }
        }
        pivots.push({ index: maxIdx, date: candles[maxIdx].date, price: maxHigh, type: 'high' });
      } else {
        // 負價區結束 → 取 min(low)
        let minLow = Infinity, minIdx = segStart;
        for (let j = 0; j < slice.length; j++) {
          if (slice[j].low < minLow) { minLow = slice[j].low; minIdx = segStart + j; }
        }
        pivots.push({ index: minIdx, date: candles[minIdx].date, price: minLow, type: 'low' });
      }
      segType = currType;
      segStart = i;
    }
  }
  return pivots;
}

/** 現行算法簡化版：3 根 K close 比中間 + 2% 最小波幅 + 高低交替 */
function findPivotsCurrent(candles: Candle[]) {
  const raw: { index: number; date: string; price: number; type: 'high' | 'low' }[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1], curr = candles[i], next = candles[i + 1];
    if (curr.close > prev.close && curr.close > next.close) {
      raw.push({ index: i, date: curr.date, price: curr.close, type: 'high' });
    } else if (curr.close < prev.close && curr.close < next.close) {
      raw.push({ index: i, date: curr.date, price: curr.close, type: 'low' });
    }
  }
  const filtered: typeof raw = [];
  for (const p of raw) {
    const last = filtered[filtered.length - 1];
    if (!last) { filtered.push(p); continue; }
    if (p.type === last.type) {
      const moreExtreme = (p.type === 'high' && p.price > last.price)
                      || (p.type === 'low'  && p.price < last.price);
      if (moreExtreme) filtered[filtered.length - 1] = p;
      continue;
    }
    const swingPct = Math.abs(p.price - last.price) / last.price;
    if (swingPct >= 0.02) filtered.push(p);
  }
  return filtered;
}

const file = path.resolve(process.cwd(), 'data/candles/TW/2345.TW.json');
const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
const all: Candle[] = raw.candles ?? raw;
const candles = all.slice(-60);
const closes = candles.map(c => c.close);
const ma5 = computeMA(closes, 5);

const book = findPivotsBook(candles, ma5);
const curr = findPivotsCurrent(candles);

console.log('\n═══ 2345 智邦，最近 60 日 ═══\n');
console.log('日期        收盤   MA5    在MA5上下');
for (let i = 50; i < candles.length; i++) {
  const c = candles[i];
  const m = ma5[i];
  const pos = m != null ? (c.close > m ? '上+' : '下-') : '--';
  console.log(`${c.date}  ${c.close.toFixed(2).padStart(6)}  ${m?.toFixed(2).padStart(6) ?? '  --'}   ${pos}`);
}

console.log('\n─── 書本 p.22 轉折波（MA5 分段 + 段內高低含影線）───');
for (const p of book) {
  console.log(`  ${p.type === 'high' ? '頭' : '底'}  ${p.date}  ${p.price.toFixed(2)}`);
}

console.log('\n─── 現行 findPivots（3 根 close 中點 + 2% 過濾）───');
for (const p of curr) {
  console.log(`  ${p.type === 'high' ? '頭' : '底'}  ${p.date}  ${p.price.toFixed(2)}`);
}
console.log('');
