/**
 * TW 上市 L1 歷史收盤稽核（2026-04-22 到 2026-04-28）
 *
 * 目的：確認是否有其他日期受到「L2 集合競價前快照注入收盤價」bug 影響
 *
 * 資料源：TWSE 官方 MI_INDEX (tables[8])
 * 對比對象：data/candles/TW/<sym>.TW.json
 * 偏差門檻：close 偏差 > 0.5%（同時統計 1%/5%）
 *
 * 用法：
 *   npx tsx scripts/audit-l1-tw-history.ts            # 只稽核不修
 *   npx tsx scripts/audit-l1-tw-history.ts --fix      # 偏差>0.5% 直接覆蓋 OHLCV
 *   npx tsx scripts/audit-l1-tw-history.ts --auto-fix # 任一日期>50 支即自動修
 */

import { promises as fs } from 'fs';
import path from 'path';

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
  lastDate?: string;
  updatedAt?: string;
  candles: Candle[];
  sealedDate?: string;
}

const DATA_DIR = path.resolve('data/candles/TW');
const DATES = ['2026-04-22', '2026-04-23', '2026-04-24', '2026-04-27', '2026-04-28'];
const FIX = process.argv.includes('--fix');
const AUTO_FIX = process.argv.includes('--auto-fix');
const AUTO_FIX_THRESHOLD = 50;
const DEV_PCT = 0.005; // 0.5%

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function toYYYYMMDD(iso: string): string {
  return iso.replace(/-/g, '');
}

function parseNum(s: string): number {
  return Number(s.replace(/,/g, ''));
}

interface TwseRow {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeShares: number; // 股
}

async function fetchTwseDay(date: string): Promise<Map<string, TwseRow>> {
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${toYYYYMMDD(date)}&type=ALLBUT0999`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`TWSE HTTP ${res.status} for ${date}`);
  const j = await res.json() as { stat: string; tables?: Array<{ title: string; fields?: string[]; data?: unknown[][] }> };
  if (j.stat !== 'OK' || !j.tables) throw new Error(`TWSE stat=${j.stat} for ${date}`);
  const t = j.tables.find(t => t.title?.includes('每日收盤行情'));
  if (!t || !t.data) throw new Error(`No daily close table for ${date}`);
  const map = new Map<string, TwseRow>();
  for (const r of t.data as string[][]) {
    const sym = r[0];
    if (!/^\d{4}$/.test(sym)) continue; // 只要 4 位數上市
    const open = parseNum(r[5]);
    const high = parseNum(r[6]);
    const low = parseNum(r[7]);
    const close = parseNum(r[8]);
    const volShares = parseNum(r[2]);
    if (!Number.isFinite(close) || close <= 0) continue;
    map.set(sym, { symbol: sym, open, high, low, close, volumeShares: volShares });
  }
  return map;
}

interface AuditRow {
  date: string;
  symbol: string;
  l1Close: number;
  officialClose: number;
  devPct: number;
}

interface DateStats {
  date: string;
  totalChecked: number;
  dev05: AuditRow[]; // > 0.5%
  dev1: number;
  dev5: number;
  fixed: number;
}

async function listTWFiles(): Promise<string[]> {
  const all = await fs.readdir(DATA_DIR);
  return all.filter(f => /^\d{4}\.TW\.json$/.test(f));
}

async function main() {
  console.log(`[audit] FIX=${FIX} AUTO_FIX=${AUTO_FIX}`);
  const files = await listTWFiles();
  console.log(`[audit] ${files.length} TW (上市 4 位數) 檔案`);

  // 先撈 5 個日期的官方資料
  const officialByDate = new Map<string, Map<string, TwseRow>>();
  for (const d of DATES) {
    process.stdout.write(`[audit] fetching TWSE ${d}... `);
    try {
      const m = await fetchTwseDay(d);
      officialByDate.set(d, m);
      console.log(`${m.size} rows`);
    } catch (e) {
      console.log(`FAIL: ${(e as Error).message}`);
    }
    await sleep(1500); // 對 TWSE 客氣點
  }

  const stats: DateStats[] = DATES.map(d => ({
    date: d,
    totalChecked: 0,
    dev05: [],
    dev1: 0,
    dev5: 0,
    fixed: 0,
  }));

  // 第一輪：純稽核
  for (const f of files) {
    const sym = f.replace('.TW.json', '');
    const fp = path.join(DATA_DIR, f);
    let raw: string;
    try { raw = await fs.readFile(fp, 'utf-8'); } catch { continue; }
    let json: CandleFile;
    try { json = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(json.candles)) continue;
    const byDate = new Map(json.candles.map(c => [c.date, c]));

    for (let i = 0; i < DATES.length; i++) {
      const d = DATES[i];
      const off = officialByDate.get(d)?.get(sym);
      if (!off) continue;
      const l1 = byDate.get(d);
      if (!l1) continue;
      stats[i].totalChecked++;
      const dev = Math.abs(l1.close - off.close) / off.close;
      if (dev > 0.05) stats[i].dev5++;
      if (dev > 0.01) stats[i].dev1++;
      if (dev > DEV_PCT) {
        stats[i].dev05.push({
          date: d, symbol: sym, l1Close: l1.close, officialClose: off.close, devPct: dev,
        });
      }
    }
  }

  // 報告
  console.log('\n## 任務 1：TW 上市歷史稽核結果\n');
  console.log('| 日期 | L1 支數 | 偏差>0.5% | 偏差>1% | 偏差>5% | 修復狀態 |');
  console.log('|------|---------|-----------|---------|---------|----------|');
  for (const s of stats) {
    const status = (FIX || (AUTO_FIX && s.dev05.length > AUTO_FIX_THRESHOLD)) ? 'WILL FIX' : 'audit only';
    console.log(`| ${s.date} | ${s.totalChecked} | ${s.dev05.length} | ${s.dev1} | ${s.dev5} | ${status} |`);
  }

  // 列出每日前 10 偏差
  for (const s of stats) {
    if (s.dev05.length === 0) continue;
    console.log(`\n### ${s.date} top 10 偏差（共 ${s.dev05.length}）`);
    s.dev05.sort((a, b) => b.devPct - a.devPct);
    for (const r of s.dev05.slice(0, 10)) {
      console.log(`  ${r.symbol}: L1 close=${r.l1Close} vs official=${r.officialClose} dev=${(r.devPct * 100).toFixed(2)}%`);
    }
  }

  // 修復階段
  if (!FIX && !AUTO_FIX) {
    console.log('\n[audit] 純稽核完成，未修檔。如要修：加 --fix 或 --auto-fix');
    return;
  }

  // 收集需要修的 (sym, date) 列表
  const fixTargets = new Map<string, Set<string>>(); // sym -> dates
  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    if (FIX || (AUTO_FIX && s.dev05.length > AUTO_FIX_THRESHOLD)) {
      for (const r of s.dev05) {
        if (!fixTargets.has(r.symbol)) fixTargets.set(r.symbol, new Set());
        fixTargets.get(r.symbol)!.add(r.date);
      }
    }
  }

  console.log(`\n[fix] 將修 ${fixTargets.size} 支股票`);
  let fixedCount = 0;
  for (const [sym, dates] of fixTargets) {
    const fp = path.join(DATA_DIR, `${sym}.TW.json`);
    let raw: string;
    try { raw = await fs.readFile(fp, 'utf-8'); } catch { continue; }
    const json: CandleFile = JSON.parse(raw);
    let changed = false;
    for (const d of dates) {
      const off = officialByDate.get(d)?.get(sym);
      if (!off) continue;
      const idx = json.candles.findIndex(c => c.date === d);
      if (idx < 0) continue;
      const newVolZhang = Math.round(off.volumeShares / 1000);
      json.candles[idx] = {
        date: d,
        open: off.open,
        high: off.high,
        low: off.low,
        close: off.close,
        volume: newVolZhang,
      };
      changed = true;
      fixedCount++;
    }
    if (changed) {
      // 維持其他欄位
      json.lastDate = json.candles[json.candles.length - 1]?.date ?? json.lastDate;
      json.updatedAt = new Date().toISOString();
      await fs.writeFile(fp, JSON.stringify(json, null, 2));
    }
  }
  console.log(`[fix] 共修 ${fixedCount} 個 (sym, date) 組合，覆寫 ${fixTargets.size} 個檔案`);
}

main().catch(e => {
  console.error('[audit] FATAL', e);
  process.exit(1);
});
