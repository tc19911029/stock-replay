/**
 * repair-ohlc-snapshots.ts
 *
 * 修復 L1 TW K 棒中的 OHLC 矛盾（high < close 或 low > close）。
 * 根因：盤中 L2 快照在股票尚未收盤前寫入 L1，導致 OHLC 不一致。
 *
 * 用法：
 *   npx tsx scripts/repair-ohlc-snapshots.ts
 *   npx tsx scripts/repair-ohlc-snapshots.ts --dates 2026-04-29,2026-04-30
 *   npx tsx scripts/repair-ohlc-snapshots.ts --dry-run
 */

import fs from 'fs';
import path from 'path';

const DRY_RUN = process.argv.includes('--dry-run');
const DATES_ARG = process.argv.find(a => a.startsWith('--dates='))?.replace('--dates=', '');
const TARGET_DATES = DATES_ARG
  ? DATES_ARG.split(',')
  : ['2026-04-24', '2026-04-29', '2026-04-30'];

const TW_DIR = path.join(process.cwd(), 'data/candles/TW');

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
    // Yahoo volume = shares; TW stocks 1張 = 1000股
    map.set(date, { date, open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +c.toFixed(2), volume: Math.round(v / 1000) });
  }
  return map;
}

function hasOHLCViolation(c: RawCandle): boolean {
  return c.high < c.close || c.low > c.close || c.high < c.open || c.low > c.open;
}

async function main() {
  console.log(`\n=== repair-ohlc-snapshots ${DRY_RUN ? '[DRY RUN]' : ''} ===`);
  console.log(`目標日期: ${TARGET_DATES.join(', ')}\n`);

  // 找出所有在目標日期有 OHLC 矛盾的檔案
  const files = fs.readdirSync(TW_DIR).filter(f => f.endsWith('.json'));
  const toFix: Map<string, Set<string>> = new Map(); // symbol → set of bad dates

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(TW_DIR, file), 'utf8'));
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
    const ticker = file.replace('.json', ''); // e.g. "2233.TW" or "1234.TWO"
    const filePath = path.join(TW_DIR, file);
    const dates = [...badDates];

    try {
      const yahoo = await fetchYahooEOD(ticker, dates);
      if (yahoo.size === 0) {
        // 嘗試另一個市場後綴
        const alt = ticker.endsWith('.TW') ? ticker.replace('.TW', '.TWO') : ticker.replace('.TWO', '.TW');
        const yahoo2 = await fetchYahooEOD(alt, dates);
        if (yahoo2.size === 0) {
          console.log(`  SKIP ${ticker}: Yahoo 無資料`);
          failed++;
          continue;
        }
        yahoo2.forEach((v, k) => yahoo.set(k, v));
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
        console.log(`  FIX ${ticker} ${c.date}: o=${c.open}→${correct.open} h=${c.high}→${correct.high} l=${c.low}→${correct.low} c=${c.close}→${correct.close} vol=${c.volume}→${correct.volume}`);
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

      // Rate limit: Yahoo 容易被限速
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
