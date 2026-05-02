/**
 * repair-cn-ohlc-snapshots.ts
 *
 * 修復 L1 CN K 棒中的 OHLC 矛盾（open > high 或 open < low 等）。
 * 根因：盤中快照寫入 L1 前的 open 可能是前一日的收盤或錯誤值。
 *
 * 用法：
 *   npx tsx scripts/repair-cn-ohlc-snapshots.ts
 *   npx tsx scripts/repair-cn-ohlc-snapshots.ts --dates 2026-04-28
 *   npx tsx scripts/repair-cn-ohlc-snapshots.ts --dry-run
 */

import fs from 'fs';
import path from 'path';

const DRY_RUN = process.argv.includes('--dry-run');
const DATES_ARG = process.argv.find(a => a.startsWith('--dates='))?.replace('--dates=', '');
const TARGET_DATES = DATES_ARG ? DATES_ARG.split(',') : ['2026-04-28'];

const CN_DIR = path.join(process.cwd(), 'data/candles/CN');

interface RawCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchYahooEOD(ticker: string, dates: string[]): Promise<Map<string, RawCandle>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=30d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo ${ticker}: HTTP ${res.status}`);
  const json = await res.json() as {
    chart: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }> } }> };
  };
  const result = json.chart.result?.[0];
  if (!result) throw new Error(`No data for ${ticker}`);

  const map = new Map<string, RawCandle>();
  const { timestamp, indicators } = result;
  const q = indicators.quote[0];

  for (let i = 0; i < timestamp.length; i++) {
    const date = new Date(timestamp[i] * 1000).toISOString().split('T')[0];
    if (!dates.includes(date)) continue;
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (!o || !h || !l || !c) continue;
    // Yahoo volume = shares; CN stocks 1手 = 100股
    map.set(date, {
      date,
      open: +o.toFixed(3),
      high: +h.toFixed(3),
      low: +l.toFixed(3),
      close: +c.toFixed(3),
      volume: Math.round(v / 100),
    });
  }
  return map;
}

function hasOHLCViolation(c: RawCandle): boolean {
  return c.high < c.close || c.low > c.close || c.high < c.open || c.low > c.open;
}

async function main() {
  console.log(`\n=== repair-cn-ohlc-snapshots ${DRY_RUN ? '[DRY RUN]' : ''} ===`);
  console.log(`目標日期: ${TARGET_DATES.join(', ')}\n`);

  const files = fs.readdirSync(CN_DIR).filter(f => f.endsWith('.json'));
  const toFix: Map<string, Set<string>> = new Map();

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(CN_DIR, file), 'utf8'));
    const candles: RawCandle[] = raw.candles ?? raw;
    if (!Array.isArray(candles)) continue;

    for (const c of candles) {
      if (!TARGET_DATES.includes(c.date)) continue;
      if (hasOHLCViolation(c)) {
        if (!toFix.has(file)) toFix.set(file, new Set());
        toFix.get(file)!.add(c.date);
      }
    }
  }

  console.log(`需修復: ${toFix.size} 支股票\n`);

  let fixed = 0, failed = 0;

  for (const [file, badDates] of toFix) {
    // file = "000610.SZ.json" → ticker = "000610.SZ"
    const ticker = file.replace('.json', '');
    const filePath = path.join(CN_DIR, file);
    const dates = [...badDates];

    try {
      const yahoo = await fetchYahooEOD(ticker, dates);
      if (yahoo.size === 0) {
        console.log(`  SKIP ${ticker}: Yahoo 無資料`);
        failed++;
        continue;
      }

      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const candles: RawCandle[] = raw.candles ?? raw;
      let fileFixed = 0;

      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        if (!dates.includes(c.date)) continue;
        const correct = yahoo.get(c.date);
        if (!correct) {
          console.log(`  MISS ${ticker} ${c.date}: Yahoo 無此日期`);
          continue;
        }
        console.log(`  FIX ${ticker} ${c.date}: o=${c.open.toFixed(3)}→${correct.open} h=${c.high.toFixed(3)}→${correct.high} l=${c.low.toFixed(3)}→${correct.low} c=${c.close.toFixed(3)}→${correct.close} vol=${c.volume}→${correct.volume}`);
        if (!DRY_RUN) {
          candles[i] = correct;
        }
        fileFixed++;
      }

      if (!DRY_RUN && fileFixed > 0) {
        if (raw.candles) raw.candles = candles;
        fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
      }
      fixed++;

      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      console.log(`  ERROR ${ticker}: ${(e as Error).message}`);
      failed++;
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n完成：修復 ${fixed} 支，失敗 ${failed} 支`);
}

main().catch(console.error);
