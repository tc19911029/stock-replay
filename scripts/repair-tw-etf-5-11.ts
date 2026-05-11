/**
 * 補 TW ETF / 00xx 系列 (不在 scanner stocklist 但有 candle 檔的 5/11 row)
 * 來源：TWSE MI_INDEX via curl (table[8])
 *
 * 用法：npx tsx scripts/repair-tw-etf-5-11.ts [--apply]
 */

import { promises as fs } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';

const TARGET_DATE = '2026-05-11';
const REPORT_FILE = path.join(process.cwd(), 'scripts', 'find-tw-missing-today-report.json');

interface BulkOHLCV { open: number; high: number; low: number; close: number; volume: number; }
interface MITable8Data { stat: string; tables: Array<{ data?: string[][] }>; }
interface Missing { symbol: string; inStocklist: boolean; lastDate: string; name?: string; }

async function fetchMIIndex(dateStr: string): Promise<Map<string, BulkOHLCV>> {
  const d = dateStr.replace(/-/g, '');
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${d}&type=ALLBUT0999`;
  const stdout = execFileSync('curl', ['-s', '--max-time', '30', '-A', 'Mozilla/5.0', url], { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
  const data = JSON.parse(stdout) as MITable8Data;
  if (data.stat !== 'OK') throw new Error(`MI_INDEX stat=${data.stat}`);
  const rows = data.tables?.[8]?.data ?? [];
  const parseNum = (s: string) => { const n = parseFloat(s.replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const map = new Map<string, BulkOHLCV>();
  for (const row of rows) {
    const code = row[0]?.trim();
    if (!code) continue;
    const open = parseNum(row[5]);
    const high = parseNum(row[6]);
    const low = parseNum(row[7]);
    const close = parseNum(row[8]);
    const volume = Math.round(parseNum(row[2]) / 1000);
    if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
  }
  return map;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const report = JSON.parse(await fs.readFile(REPORT_FILE, 'utf-8')) as { missing: Missing[] };
  // 不在 stocklist 但本地有檔的 .TW（多半是 ETF / 權證留下的 candle）
  const targets = report.missing.filter(m => !m.inStocklist && m.symbol.endsWith('.TW'));
  console.log(`[load] 非 stocklist 但缺 5/11 的 .TW: ${targets.length} 支`);

  if (targets.length === 0) return;

  console.log(`[fetch] TWSE MI_INDEX ${TARGET_DATE} ...`);
  const twse = await fetchMIIndex(TARGET_DATE);
  console.log(`        TWSE table[8]: ${twse.size} 支有 OHLC`);

  type Plan = { symbol: string; action: 'write' | 'halted'; ohlcv?: BulkOHLCV };
  const plan: Plan[] = [];
  for (const t of targets) {
    const code = t.symbol.replace(/\.TW$/i, '');
    const ohlcv = twse.get(code);
    if (ohlcv) plan.push({ symbol: t.symbol, action: 'write', ohlcv });
    else plan.push({ symbol: t.symbol, action: 'halted' });
  }
  const writes = plan.filter(p => p.action === 'write');
  const halted = plan.filter(p => p.action === 'halted');
  console.log(`[plan] write=${writes.length}, halted/no-data=${halted.length}`);
  if (halted.length > 0 && halted.length <= 30) {
    console.log(`        halted: ${halted.map(p => p.symbol).join(', ')}`);
  }

  if (!apply) { console.log('\n[dry-run] 加 --apply 來實際寫'); return; }

  let written = 0, failed = 0;
  for (const p of writes) {
    if (!p.ohlcv) continue;
    try {
      await saveLocalCandles(p.symbol, 'TW', [{ date: TARGET_DATE, ...p.ohlcv }]);
      written++;
    } catch (err) {
      failed++;
      console.warn(`  ${p.symbol} 寫入失敗: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\n[done] 寫入 ${written}, 失敗 ${failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
