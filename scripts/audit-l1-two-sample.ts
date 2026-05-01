/**
 * TWO 上櫃 L1 抽樣稽核（04-30，最新已封存日）
 *
 * 資料源：TPEx openapi
 *   https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes
 *   注意：date 參數不會過濾，回傳最新交易日
 *
 * 抽樣 20 支熱門上櫃股
 */

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data/candles/TW');
const TARGET_DATE = '2026-04-30';

const SAMPLES = [
  '3105', '3105', '3661', '3105', '5483', '6488', '6669', '3529',
  '6573', '6510', '8069', '6488', '6147', '5274', '3260', '6121',
  '4966', '6531', '6446', '6488', '6464', '5347', '4763',
];

interface TpexRow {
  Date: string;
  SecuritiesCompanyCode: string;
  CompanyName: string;
  Close: string;
  Open: string;
  High: string;
  Low: string;
  TradingShares: string;
}

async function fetchTpex(): Promise<Map<string, { open: number; high: number; low: number; close: number; volumeShares: number; date: string }>> {
  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`TPEx HTTP ${res.status}`);
  const arr = await res.json() as TpexRow[];
  const out = new Map<string, { open: number; high: number; low: number; close: number; volumeShares: number; date: string }>();
  for (const r of arr) {
    if (!r.SecuritiesCompanyCode) continue;
    out.set(r.SecuritiesCompanyCode, {
      open: parseFloat(r.Open),
      high: parseFloat(r.High),
      low: parseFloat(r.Low),
      close: parseFloat(r.Close),
      volumeShares: parseInt(r.TradingShares, 10),
      date: r.Date, // ROC like 1150430
    });
  }
  return out;
}

async function main() {
  console.log('## 任務 3：TWO 上櫃抽樣\n');
  const tpex = await fetchTpex();
  // 確認 ROC 日期是 1150430
  const sampleRow = [...tpex.values()][0];
  console.log(`[TPEx] 拿到 ${tpex.size} 筆，ROC 日期 = ${sampleRow?.date}`);
  console.log('');
  console.log('| symbol | 日期 | L1 close | TPEx close | 偏差% |');
  console.log('|--------|------|----------|------------|-------|');

  const seen = new Set<string>();
  let issues = 0;
  let total = 0;
  for (const code of SAMPLES) {
    if (seen.has(code)) continue;
    seen.add(code);
    const sym = `${code}.TWO`;
    const fp = path.join(DATA_DIR, `${sym}.json`);
    let raw: string;
    try { raw = await fs.readFile(fp, 'utf-8'); } catch { console.log(`| ${sym} | ${TARGET_DATE} | (no file) | - | - |`); continue; }
    const json = JSON.parse(raw);
    const arr = json.candles ?? [];
    const l1 = arr.find((c: { date: string }) => c.date === TARGET_DATE);
    const off = tpex.get(code);
    if (!l1) { console.log(`| ${sym} | ${TARGET_DATE} | (no L1 row) | ${off?.close ?? '—'} | - |`); continue; }
    if (!off) { console.log(`| ${sym} | ${TARGET_DATE} | ${l1.close} | (not in TPEx) | - |`); continue; }
    total++;
    const dev = (l1.close - off.close) / off.close;
    const flag = Math.abs(dev) > 0.005 ? ' ⚠️' : '';
    if (Math.abs(dev) > 0.005) issues++;
    console.log(`| ${sym} | ${TARGET_DATE} | ${l1.close} | ${off.close} | ${(dev * 100).toFixed(2)}%${flag} |`);
  }
  console.log(`\n[TWO] 偏差>0.5% 共 ${issues} 筆 / ${total} 抽樣`);
}

main().catch(e => { console.error(e); process.exit(1); });
