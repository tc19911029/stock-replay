/**
 * 修復 2026 年 .TWO（上櫃）漲跌停 close 被盤中污染的案例（FinMind）。
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { writeCandleFile } from '../lib/datasource/CandleStorageAdapter';

interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number; }
interface Suspect { symbol: string; date: string; }

const TOKEN = process.env.FINMIND_API_TOKEN ?? '';

function loadSuspects(): Suspect[] {
  const out: Suspect[] = [];
  const dir = 'data/candles/TW';
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || !f.includes('.TWO')) continue;
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

interface FinMindRow { date: string; Trading_Volume: number; open: number; max: number; min: number; close: number; }

async function fetchFinMind(code: string, start: string, end: string): Promise<Candle[]> {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${code}&start_date=${start}&end_date=${end}${TOKEN ? `&token=${TOKEN}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
  const json = await res.json() as { status: number; data?: FinMindRow[] };
  if (json.status !== 200 || !json.data) return [];
  return json.data.map(r => ({
    date: r.date,
    open: r.open,
    high: r.max,
    low: r.min,
    close: r.close,
    volume: Math.round(r.Trading_Volume / 1000),
  }));
}

async function main(): Promise<void> {
  const suspects = loadSuspects();
  console.log(`📍 .TWO 候選異常: ${suspects.length} 筆`);

  const groups = new Map<string, Set<string>>();
  for (const s of suspects) {
    const code = s.symbol.replace(/\.(TW|TWO)$/i, '');
    const yyyymm = s.date.substring(0, 7);
    if (!groups.has(`${s.symbol}|${code}|${yyyymm}`)) groups.set(`${s.symbol}|${code}|${yyyymm}`, new Set());
    groups.get(`${s.symbol}|${code}|${yyyymm}`)!.add(s.date);
  }
  console.log(`📍 分組 ${groups.size} 個 (symbol, month)\n`);

  let fixed = 0, unchanged = 0, notFound = 0;
  const fixes: { symbol: string; date: string; oldC: number; newC: number }[] = [];
  const cache = new Map<string, Candle[]>();

  for (const [key, dates] of groups) {
    const [symbol, code, yyyymm] = key.split('|');
    const start = `${yyyymm}-01`;
    const end = `${yyyymm}-31`;
    const ck = `${code}|${yyyymm}`;
    let rows = cache.get(ck);
    if (!rows) {
      rows = await fetchFinMind(code, start, end);
      cache.set(ck, rows);
      await new Promise(r => setTimeout(r, 200));
    }
    if (rows.length === 0) { notFound += dates.size; continue; }

    const l1Path = path.join('data/candles/TW', `${symbol}.json`);
    const l1 = JSON.parse(readFileSync(l1Path, 'utf8')) as { candles?: Candle[] };
    const l1Map = new Map(l1.candles!.map(c => [c.date, c]));
    const toFix: Candle[] = [];
    for (const d of dates) {
      const official = rows.find(r => r.date === d);
      const local = l1Map.get(d);
      if (!official || !local) { notFound++; continue; }
      if (Math.abs(official.close - local.close) / local.close > 0.005) {
        toFix.push(official);
        fixes.push({ symbol, date: d, oldC: local.close, newC: official.close });
        fixed++;
      } else {
        unchanged++;
      }
    }
    if (toFix.length > 0) {
      await writeCandleFile(symbol, 'TW', toFix);
    }
  }
  console.log(`\n✅ 修復: ${fixed} | 已正確: ${unchanged} | 找不到: ${notFound}\n`);
  for (const f of fixes) console.log(`  ${f.symbol} ${f.date}: ${f.oldC} → ${f.newC}`);
}

main().catch(err => { console.error(err); process.exit(1); });
