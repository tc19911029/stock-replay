/**
 * 修復 TWO 上櫃股票歷史 OHLC 倒轉（close > high 或 close < low > 5%）
 *
 * 根因：歷史抓取時 high/low 沒做除權息調整，但 close 已調整 → 邏輯反轉。
 * 修法：用 Yahoo Finance（split + dividend adjusted，OHLC 一致）覆寫問題日期。
 *
 * 流程：
 *   1. 掃 data/candles/TW/*.TWO.json，找出 close>high 或 close<low（差距>5%）
 *   2. 對每支受影響股票抓 Yahoo 2 年資料
 *   3. 只覆寫問題日期的 K 棒（writeCandleFile 同日 incoming 覆蓋）
 *   4. 跑完後另跑 sync-repaired-to-blob.ts 推上 production
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { writeCandleFile } from '../lib/datasource/CandleStorageAdapter';

const TW_DIR = path.join('data', 'candles', 'TW');
const DEVIATION_THRESHOLD = 0.05; // 5%
const CONCURRENCY = 5;
const BATCH_SLEEP_MS = 300;

interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandleFile {
  symbol: string;
  candles: Candle[];
}

interface BadBar {
  date: string;
  high: number;
  low: number;
  close: number;
  kind: 'close>high' | 'close<low';
  deviation: number; // relative deviation
}

interface AffectedStock {
  symbol: string; // e.g. 1742.TWO
  bad: BadBar[];
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ---------- Step 1: scan ----------
function findBadBars(candles: Candle[]): BadBar[] {
  const bad: BadBar[] = [];
  for (const c of candles) {
    if (!c || typeof c.close !== 'number' || c.close <= 0) continue;
    if (c.high <= 0 || c.low <= 0) continue;

    if (c.close > c.high) {
      const dev = (c.close - c.high) / c.high;
      if (dev > DEVIATION_THRESHOLD) {
        bad.push({ date: c.date, high: c.high, low: c.low, close: c.close, kind: 'close>high', deviation: dev });
      }
    } else if (c.close < c.low) {
      const dev = (c.low - c.close) / c.low;
      if (dev > DEVIATION_THRESHOLD) {
        bad.push({ date: c.date, high: c.high, low: c.low, close: c.close, kind: 'close<low', deviation: dev });
      }
    }
  }
  return bad;
}

async function scanTwoFiles(): Promise<AffectedStock[]> {
  const files = await fs.readdir(TW_DIR);
  const twoFiles = files.filter(f => f.endsWith('.TWO.json'));
  const affected: AffectedStock[] = [];

  for (const f of twoFiles) {
    try {
      const raw = await fs.readFile(path.join(TW_DIR, f), 'utf8');
      const j = JSON.parse(raw) as CandleFile;
      if (!j.candles?.length) continue;
      const bad = findBadBars(j.candles);
      if (bad.length > 0) {
        affected.push({ symbol: f.replace('.json', ''), bad });
      }
    } catch {
      /* skip */
    }
  }
  return affected;
}

// ---------- Step 2: Yahoo fetch ----------
async function fetchYahoo2y(symbol: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2y&includePrePost=false`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators: {
          quote: Array<{
            open: (number | null)[];
            high: (number | null)[];
            low: (number | null)[];
            close: (number | null)[];
            volume: (number | null)[];
          }>;
        };
      }>;
    };
  };
  const r = json.chart?.result?.[0];
  if (!r?.timestamp) return [];
  const q = r.indicators.quote[0];
  const out: Candle[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const close = q.close[i];
    const high = q.high[i];
    const low = q.low[i];
    const open = q.open[i];
    if (close == null || close <= 0) continue;
    if (high == null || low == null) continue;
    const d = new Date(r.timestamp[i] * 1000);
    const date = d.toISOString().slice(0, 10);
    const o = open ?? close;
    // Yahoo 偶有 close 已調整、high/low 未調整 → 強制 OHLC 自洽
    const fixedHigh = Math.max(o, high, close);
    const fixedLow = Math.min(o, low, close);
    out.push({
      date,
      open: o,
      high: fixedHigh,
      low: fixedLow,
      close,
      // Yahoo volume 單位是「股」，L1 單位是「張」(=1000 股)
      volume: Math.round((q.volume[i] ?? 0) / 1000),
    });
  }
  return out;
}

// ---------- Step 3: repair one stock ----------
interface RepairResult {
  symbol: string;
  patched: number;
  skippedNoYahoo: number;
}

async function repairStock(stock: AffectedStock): Promise<RepairResult | null> {
  const yahoo = await fetchYahoo2y(stock.symbol);
  if (yahoo.length === 0) return null;

  const yahooMap = new Map<string, Candle>();
  for (const c of yahoo) yahooMap.set(c.date, c);

  const patches: Candle[] = [];
  let skippedNoYahoo = 0;
  for (const b of stock.bad) {
    const yc = yahooMap.get(b.date);
    if (!yc) {
      skippedNoYahoo++;
      continue;
    }
    patches.push(yc);
  }

  if (patches.length === 0) return { symbol: stock.symbol, patched: 0, skippedNoYahoo };

  // writeCandleFile 會以 date 為 key 合併：incoming 覆蓋同日，不影響其他日期
  await writeCandleFile(stock.symbol, 'TW', patches);
  return { symbol: stock.symbol, patched: patches.length, skippedNoYahoo };
}

// ---------- Step 4: orchestrate ----------
async function main() {
  console.log('Step 1: 掃描 TWO 檔案找 close>high 或 close<low > 5% ...');
  const affected = await scanTwoFiles();
  console.log(`受影響 TWO 股票數: ${affected.length}`);

  let totalBad = 0;
  for (const s of affected) totalBad += s.bad.length;
  console.log(`問題 K 棒總數: ${totalBad}`);

  // 最大偏差案例（前 5）
  const allBad: Array<{ symbol: string; bar: BadBar }> = [];
  for (const s of affected) {
    for (const b of s.bad) allBad.push({ symbol: s.symbol, bar: b });
  }
  allBad.sort((a, b) => b.bar.deviation - a.bar.deviation);
  console.log('\n最大偏差案例（前 5）：');
  for (const x of allBad.slice(0, 5)) {
    const pct = (x.bar.deviation * 100).toFixed(1);
    console.log(
      `  ${x.symbol} ${x.bar.date} ${x.bar.kind} high=${x.bar.high} low=${x.bar.low} close=${x.bar.close} 偏差=${pct}%`,
    );
  }

  if (affected.length === 0) {
    console.log('\n無需修復');
    return;
  }

  console.log(`\nStep 2-3: Yahoo 抓 + 覆寫（concurrency=${CONCURRENCY}）...`);
  let fixed = 0;
  let noYahoo = 0;
  let totalPatched = 0;
  const failedSymbols: string[] = [];

  for (let i = 0; i < affected.length; i += CONCURRENCY) {
    const batch = affected.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(s => repairStock(s)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const s = batch[j];
      if (r.status === 'fulfilled' && r.value) {
        if (r.value.patched > 0) {
          fixed++;
          totalPatched += r.value.patched;
        } else {
          noYahoo++;
          failedSymbols.push(s.symbol);
        }
      } else {
        noYahoo++;
        failedSymbols.push(s.symbol);
      }
    }
    const done = Math.min(i + CONCURRENCY, affected.length);
    process.stdout.write(`\r  ${done}/${affected.length} fixed=${fixed} noYahoo=${noYahoo} patched=${totalPatched}`);
    await sleep(BATCH_SLEEP_MS);
  }
  console.log('');

  console.log('\n=== 結果 ===');
  console.log(`受影響 TWO 股票數: ${affected.length}`);
  console.log(`修好的: ${fixed}`);
  console.log(`Yahoo 抓不到的: ${noYahoo}`);
  console.log(`修補的 K 棒總數: ${totalPatched}`);
  if (failedSymbols.length > 0) {
    console.log(`\n抓不到的股票（停牌/退市可能）：`);
    console.log(failedSymbols.join(', '));
  }
  console.log('\n下一步：npx tsx scripts/sync-repaired-to-blob.ts 2');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
