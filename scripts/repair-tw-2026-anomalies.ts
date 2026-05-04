/**
 * 廣域修復 2026 年 TW 漲跌停 close 被盤中污染的所有疑似案例。
 *
 * 流程：
 *   1) 掃 L1 找 2026 漲停/跌停 close 偏離 high/low > 3% + 隔日跳空 > 5% 的案例
 *   2) 對每個 (symbol, month) fetch TWSE STOCK_DAY 官方資料
 *   3) 逐日比對 close 偏差 > 0.5%，覆寫該日 OHLC + volume
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { writeCandleFile } from '../lib/datasource/CandleStorageAdapter';

interface Suspect { symbol: string; date: string; }
interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number; }

function loadSuspects(): Suspect[] {
  const out: Suspect[] = [];
  const dir = 'data/candles/TW';
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { candles?: Candle[] } | Candle[];
      const arr: Candle[] = Array.isArray(j) ? j : (j.candles ?? []);
      if (arr.length < 3) continue;
      const sym = f.replace('.json', '');
      const limit = 0.098;
      for (let i = 1; i < arr.length - 1; i++) {
        const prev = arr[i - 1], cur = arr[i], next = arr[i + 1];
        if (!prev || !cur || !next || prev.close <= 0) continue;
        if (!cur.date.startsWith('2026')) continue;
        const limitUp = prev.close * (1 + limit);
        const limitDown = prev.close * (1 - limit);
        const upBad = cur.high >= limitUp * 0.999 && cur.close < cur.high * 0.97 && next.open / cur.close > 1.05;
        const downBad = cur.low <= limitDown * 1.001 && cur.close > cur.low * 1.03 && next.open / cur.close < 0.95;
        if (upBad || downBad) out.push({ symbol: sym, date: cur.date });
      }
    } catch { /* skip */ }
  }
  return out;
}

interface TwseRow { 0: string; 1: string; 2: string; 3: string; 4: string; 5: string; 6: string; }

function rocToIso(roc: string): string {
  const [y, m, d] = roc.split('/');
  return `${parseInt(y, 10) + 1911}-${m}-${d}`;
}
const num = (s: string): number => parseFloat(s.replace(/,/g, ''));

const monthCache = new Map<string, Candle[]>();

async function fetchTwseMonth(stockNo: string, yyyymm: string): Promise<Candle[]> {
  const key = `${stockNo}-${yyyymm}`;
  const hit = monthCache.get(key);
  if (hit) return hit;
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${yyyymm}01&stockNo=${stockNo}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    monthCache.set(key, []);
    return [];
  }
  const json = await res.json() as { data?: TwseRow[] };
  const out: Candle[] = (json.data ?? []).map((r) => ({
    date: rocToIso(r[0]),
    open: num(r[3]),
    high: num(r[4]),
    low: num(r[5]),
    close: num(r[6]),
    volume: Math.round(num(r[1]) / 1000),
  }));
  monthCache.set(key, out);
  return out;
}

async function main(): Promise<void> {
  const suspects = loadSuspects();
  console.log(`📍 2026 年候選異常: ${suspects.length} 筆`);

  // group by symbol+month
  const groups = new Map<string, Set<string>>();
  for (const s of suspects) {
    const code = s.symbol.replace(/\.(TW|TWO)$/i, '');
    const yyyymm = s.date.substring(0, 7).replace('-', '');
    const key = `${s.symbol}|${code}|${yyyymm}`;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(s.date);
  }
  console.log(`📍 分組 ${groups.size} 個 (symbol, month)\n`);

  let fixed = 0, unchanged = 0, notFound = 0, fail = 0;
  const fixes: { symbol: string; date: string; oldC: number; newC: number }[] = [];

  for (const [key, dates] of groups) {
    const [symbol, code, yyyymm] = key.split('|');
    try {
      const rows = await fetchTwseMonth(code, yyyymm);
      if (rows.length === 0) {
        notFound += dates.size;
        await new Promise(r => setTimeout(r, 600));
        continue;
      }
      // 讀現 L1
      const l1Path = path.join('data/candles/TW', `${symbol}.json`);
      const l1 = JSON.parse(readFileSync(l1Path, 'utf8')) as { candles?: Candle[] };
      const l1Map = new Map(l1.candles!.map(c => [c.date, c]));
      const fixesForSymbol: Candle[] = [];
      for (const d of dates) {
        const official = rows.find(r => r.date === d);
        const local = l1Map.get(d);
        if (!official || !local) { notFound++; continue; }
        // 比對 close 偏差 > 0.5% 才修
        if (Math.abs(official.close - local.close) / local.close > 0.005) {
          fixesForSymbol.push(official);
          fixes.push({ symbol, date: d, oldC: local.close, newC: official.close });
          fixed++;
        } else {
          unchanged++;
        }
      }
      if (fixesForSymbol.length > 0) {
        await writeCandleFile(symbol, 'TW', fixesForSymbol);
      }
      await new Promise(r => setTimeout(r, 600));
    } catch (err) {
      fail += dates.size;
      console.log(`   ❌ ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n✅ 修復: ${fixed} | 已正確: ${unchanged} | 找不到官方: ${notFound} | 失敗: ${fail}\n`);
  console.log('--- 修復清單 ---');
  for (const f of fixes) {
    console.log(`  ${f.symbol} ${f.date}: ${f.oldC} → ${f.newC}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
