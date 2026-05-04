/**
 * 修復 2026-04-29 9 支 TW 漲停股 close 被盤中低點覆寫的 bug。
 *
 * 模式：high == prev.close * 1.098（漲停板），但 L1 close < high * 0.97（被打回低點），
 * 隔日 open / L1 close > 1.05（破物理 10% 跳空限制）。
 *
 * 用 TWSE STOCK_DAY 官方資料覆寫該日 OHLC + volume。
 * 受影響股票：1722 / 2340 / 2486 / 4562 / 4807 / 6552 / 6706 / 6919 / 8162
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { writeCandleFile } from '../lib/datasource/CandleStorageAdapter';

const TARGETS = ['1722', '2340', '2486', '4562', '4807', '6552', '6706', '6919', '8162'];
const TARGET_DATE = '2026-04-29';

interface TwseRow {
  0: string; 1: string; 2: string; 3: string; 4: string; 5: string;
  6: string; 7: string; 8: string; 9: string;
}

function rocToIso(roc: string): string {
  const [y, m, d] = roc.split('/');
  return `${parseInt(y, 10) + 1911}-${m}-${d}`;
}

function num(s: string): number {
  return parseFloat(s.replace(/,/g, ''));
}

async function fetchTwseMonth(stockNo: string): Promise<{ date: string; open: number; high: number; low: number; close: number; volume: number }[]> {
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20260401&stockNo=${stockNo}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { data?: TwseRow[] };
  if (!json.data) return [];
  return json.data.map((r) => ({
    date: rocToIso(r[0]),
    open: num(r[3]),
    high: num(r[4]),
    low: num(r[5]),
    close: num(r[6]),
    volume: Math.round(num(r[1]) / 1000), // 股 → 張
  }));
}

async function main(): Promise<void> {
  console.log(`📍 目標日期: ${TARGET_DATE}`);
  console.log(`📍 受影響股票: ${TARGETS.length} 支\n`);

  let ok = 0, fail = 0;
  for (const code of TARGETS) {
    try {
      const rows = await fetchTwseMonth(code);
      const target = rows.find(r => r.date === TARGET_DATE);
      if (!target) {
        console.log(`   ❌ ${code}: TWSE 無 ${TARGET_DATE} 資料`);
        fail++;
        continue;
      }
      // 只覆寫該天，writeCandleFile 會 merge by date
      await writeCandleFile(`${code}.TW`, 'TW', [target]);
      console.log(`   ✅ ${code}: close=${target.close} high=${target.high} vol=${target.volume}`);
      ok++;
      await new Promise(r => setTimeout(r, 600)); // TWSE rate limit
    } catch (err) {
      console.log(`   ❌ ${code}: ${err instanceof Error ? err.message : String(err)}`);
      fail++;
    }
  }
  console.log(`\n✅ 完成：ok=${ok} fail=${fail}`);
}

main().catch(err => { console.error(err); process.exit(1); });
