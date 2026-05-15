/**
 * 強制刷新大盤指數 K 線（^TWII / 000001.SS）
 *
 * 從 Yahoo / EODHD 抓最新資料覆寫 L1。
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';

async function refresh(market: 'TW' | 'CN') {
  const scanner = market === 'TW' ? new TaiwanScanner() : new ChinaScanner();
  const sym = market === 'TW' ? '^TWII' : '000001.SS';
  console.log(`[${market}] 刷新 ${sym}...`);
  try {
    const candles = await scanner.fetchCandles(sym);
    console.log(`  取得 ${candles.length} 根 K 棒, last=${candles[candles.length - 1]?.date}`);
    if (candles.length < 30) {
      console.error(`  ✗ 太少 candles，跳過寫入`);
      return;
    }
    const out = path.join(REPO_ROOT, 'data', 'candles', market, `${sym}.json`);
    // INDEX volume=0 守 prev V（Yahoo Chart 對 INDEX 當日 vol 同步慢；對齊 CandleStorageAdapter 0513 防呆）
    const stripped = candles.map((c, i) => {
      const v = (c.volume === 0 && i > 0) ? candles[i - 1].volume : c.volume;
      return { date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: v };
    });
    const data = {
      symbol: sym,
      lastDate: stripped[stripped.length - 1].date,
      updatedAt: new Date().toISOString(),
      candles: stripped,
      sealedDate: stripped[stripped.length - 1].date,
    };
    await fs.writeFile(out, JSON.stringify(data));
    console.log(`  ✓ 寫入 ${out}`);
  } catch (err) {
    console.error(`  ✗ 失敗：${err}`);
  }
}

async function main() {
  const targets = process.argv.slice(2).filter((a) => a === 'TW' || a === 'CN');
  if (targets.length === 0) targets.push('TW', 'CN');
  for (const m of targets) await refresh(m as 'TW' | 'CN');
}

main();
