/**
 * 清除 L1 中所有全 0 K 棒（OHLCV 全 0），然後補抓
 *
 * 用法：npx tsx scripts/clean-zero-bars.ts
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { writeCandleFile, readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { TWSEHistProvider } from '../lib/datasource/TWSEHistProvider';
import { yahooProvider } from '../lib/datasource/YahooDataProvider';
import { eastMoneyHistProvider } from '../lib/datasource/EastMoneyHistProvider';
import { tencentHistProvider } from '../lib/datasource/TencentHistProvider';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const twse = new TWSEHistProvider();

function isZeroBar(c: { open: number; high: number; low: number; close: number }): boolean {
  return c.open === 0 && c.high === 0 && c.low === 0 && c.close === 0;
}

async function fetchTW(symbol: string) {
  try {
    const c = await twse.getHistoricalCandles(symbol, '2y');
    if (c.length >= 100) return c;
  } catch {}
  try {
    const c = await yahooProvider.getHistoricalCandles(symbol, '2y');
    if (c.length >= 100) return c;
  } catch {}
  return [];
}

async function fetchCN(symbol: string) {
  try {
    const c = await eastMoneyHistProvider.getHistoricalCandles(symbol, '2y');
    if (c.length >= 100) return c;
  } catch {}
  try {
    const c = await tencentHistProvider.getHistoricalCandles(symbol, '2y');
    if (c.length >= 100) return c;
  } catch {}
  try {
    const c = await yahooProvider.getHistoricalCandles(symbol, '2y');
    if (c.length >= 100) return c;
  } catch {}
  return [];
}

async function main() {
  for (const market of ['TW', 'CN'] as const) {
    const dir = `./data/candles/${market}`;
    const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('^'));
    const targets: string[] = [];

    for (const f of files) {
      const sym = f.replace('.json','');
      const j = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      const candles = j.candles as any[];
      if (candles.some(c => isZeroBar(c))) targets.push(sym);
    }

    console.log(`\n[${market}] ${targets.length} 支有 0 K 棒，開始處理`);

    for (const sym of targets) {
      // 先讀現有 → 過濾掉 0 K 棒 → 寫回
      const existing = await readCandleFile(sym, market);
      if (!existing) continue;
      const cleaned = existing.candles.filter(c => !isZeroBar(c));
      const removed = existing.candles.length - cleaned.length;

      // 補抓
      const fresh = market === 'TW' ? await fetchTW(sym) : await fetchCN(sym);

      if (fresh.length > 0) {
        // writeCandleFile 內部會 merge：先寫 fresh，再用 fresh 覆蓋同日的 0 K 棒
        // 但如果 fresh 沒有 4/27, 4/28 的資料（停牌真相），merge 會保留舊的 0 K 棒
        // 所以要先寫 cleaned（0 已過濾），再 merge fresh
        const map = new Map<string, any>();
        for (const c of cleaned) map.set(c.date, c);
        for (const c of fresh) {
          if (!isZeroBar(c)) map.set(c.date, c);
        }
        const merged = [...map.values()].sort((a,b) => a.date.localeCompare(b.date));
        // 直接呼叫底層寫入（繞過 merge 邏輯），避免 0 K 棒復活
        const { promises: fs } = await import('fs');
        const path = await import('path');
        const data = {
          symbol: sym,
          lastDate: merged[merged.length-1].date,
          updatedAt: new Date().toISOString(),
          candles: merged,
          sealedDate: merged[merged.length-1].date,
        };
        await fs.writeFile(path.join(dir, `${sym}.json`), JSON.stringify(data), 'utf-8');
        console.log(`  ${sym}: 移除 ${removed} 0 K → 寫回 ${merged.length} 根`);
      } else {
        // 沒有新資料 → 只保留清掉 0 後的版本
        const { promises: fs } = await import('fs');
        const path = await import('path');
        const data = {
          symbol: sym,
          lastDate: cleaned[cleaned.length-1].date,
          updatedAt: new Date().toISOString(),
          candles: cleaned,
          sealedDate: cleaned[cleaned.length-1].date,
        };
        await fs.writeFile(path.join(dir, `${sym}.json`), JSON.stringify(data), 'utf-8');
        console.log(`  ${sym}: 移除 ${removed} 0 K (無新資料補)`);
      }

      await sleep(market === 'CN' ? 1500 : 500);
    }
  }
}

main().catch(console.error);
