/**
 * 修復 L1 被縮短/有洞的股票
 *
 * 策略：對於每支 L1 < 400 根或有 20+ 天 gap 的股票，
 * 用 Yahoo provider 拉完整 2 年資料，透過 merge-safe writeCandleFile
 * 只補缺漏不覆蓋既有。
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { yahooProvider } from '../lib/datasource/YahooDataProvider';
import { writeCandleFile } from '../lib/datasource/CandleStorageAdapter';

const CONCURRENCY = 6;
const DELAY_MS = 500;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function scan(market: 'TW' | 'CN') {
  const dir = path.join('data', 'candles', market);
  const files = await fs.readdir(dir);
  const broken: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      const c = j.candles as { date: string }[];
      if (!c || c.length === 0) continue;
      if (c.length < 400) { broken.push(f); continue; }
      for (let i = 1; i < c.length; i++) {
        const prev = new Date(c[i - 1].date);
        const cur = new Date(c[i].date);
        const diff = (cur.getTime() - prev.getTime()) / 86400000;
        if (diff >= 20) { broken.push(f); break; }
      }
    } catch { /* skip */ }
  }
  return broken;
}

async function repair(market: 'TW' | 'CN', filenames: string[]) {
  console.log(`\n🔧 [${market}] 修復 ${filenames.length} 支`);
  let ok = 0, fail = 0;

  for (let i = 0; i < filenames.length; i += CONCURRENCY) {
    const batch = filenames.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async (fname) => {
      const symbol = fname.replace('.json', '');
      try {
        const candles = await yahooProvider.getHistoricalCandles(symbol, '2y');
        if (candles.length >= 200) {
          await writeCandleFile(symbol, market, candles);
          ok++;
        } else {
          fail++;
        }
      } catch {
        fail++;
      }
    }));
    await sleep(DELAY_MS);
    const pct = Math.round((i + CONCURRENCY) / filenames.length * 100);
    process.stdout.write(`\r   進度: ${Math.min(100, pct)}% (成功${ok} 失敗${fail})`);
  }
  console.log(`\n   ✅ 完成: 成功 ${ok}, 失敗 ${fail}`);
}

async function main() {
  const args = process.argv.slice(2);
  const markets: ('TW' | 'CN')[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--market' && i + 1 < args.length) {
      const m = args[i + 1].toUpperCase() as 'TW' | 'CN';
      if (m === 'TW' || m === 'CN') markets.push(m);
      i++;
    }
  }
  const targets = markets.length > 0 ? markets : (['TW', 'CN'] as const);

  for (const m of targets) {
    const broken = await scan(m);
    console.log(`[${m}] 掃描結果: ${broken.length} 支需修復`);
    if (broken.length > 0) await repair(m, broken);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
