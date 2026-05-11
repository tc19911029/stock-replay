/**
 * 補 TPEx bulk + per-symbol 都吃不到的 leftover 13 支 (5/11)
 *
 * 來源：TWSE MI_INDEX via curl (Cloudflare TLS 阻 Node fetch；curl 可)
 *       - table[8] = 每日收盤行情(全部) → Code, OpeningPrice, HighestPrice, LowestPrice, ClosingPrice
 *
 * 用法：npx tsx scripts/repair-tw-leftover-5-11.ts [--apply]
 */

import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';

const TARGET_DATE = '2026-05-11';
const LEFTOVERS = [
  '2645.TW', '3593.TW', '6116.TW', '6431.TW', '9103.TW', '9136.TW',
  '2073.TWO', '3067.TWO', '6171.TWO', '6236.TWO', '7713.TWO', '8921.TWO', '8923.TWO',
];

interface MITable8Data {
  stat: string;
  tables: Array<{ data?: string[][] }>;
}

async function fetchMIIndex(dateStr: string): Promise<Map<string, { open: number; high: number; low: number; close: number; volume: number }>> {
  const d = dateStr.replace(/-/g, '');
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${d}&type=ALLBUT0999`;
  const stdout = execFileSync(
    'curl',
    ['-s', '--max-time', '30', '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', url],
    { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout) as MITable8Data;
  if (data.stat !== 'OK') throw new Error(`MI_INDEX stat=${data.stat}`);
  const rows = data.tables?.[8]?.data ?? [];
  const parseNum = (s: string) => { const n = parseFloat(s.replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const map = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>();
  for (const row of rows) {
    const code = row[0]?.trim();
    if (!code) continue;
    const open = parseNum(row[5]);
    const high = parseNum(row[6]);
    const low = parseNum(row[7]);
    const close = parseNum(row[8]);
    const volume = Math.round(parseNum(row[2]) / 1000); // 股 → 張
    if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
  }
  return map;
}

async function fetchTPExBulk(dateStr: string): Promise<Map<string, { open: number; high: number; low: number; close: number; volume: number }>> {
  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes';
  const stdout = execFileSync(
    'curl',
    ['-s', '--max-time', '30', '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', url],
    { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 },
  );
  const rows = JSON.parse(stdout) as Array<Record<string, string>>;
  const parseROC = (raw: string) => {
    const m = raw.match(/^(\d{3})(\d{2})(\d{2})$/);
    if (!m) return null;
    return `${parseInt(m[1], 10) + 1911}-${m[2]}-${m[3]}`;
  };
  const parseNum = (s?: string) => { if (!s) return 0; const n = parseFloat(s.replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const map = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>();
  for (const row of rows) {
    if (parseROC(row.Date ?? '') !== dateStr) continue;
    const code = (row.SecuritiesCompanyCode ?? '').trim();
    if (!code) continue;
    const open = parseNum(row.Open);
    const high = parseNum(row.High);
    const low = parseNum(row.Low);
    const close = parseNum(row.Close);
    const volume = Math.round(parseNum(row.TradingShares) / 1000);
    // 即使 open=0 也記（給後面看，但只當作 halted）
    map.set(code, { open, high, low, close, volume });
  }
  return map;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`[mode] ${apply ? 'APPLY' : 'DRY-RUN'}`);

  console.log(`[fetch] TWSE MI_INDEX & TPEx bulk for ${TARGET_DATE} ...`);
  const [twse, tpex] = await Promise.all([fetchMIIndex(TARGET_DATE), fetchTPExBulk(TARGET_DATE)]);
  console.log(`        TWSE table[8]: ${twse.size} 支有 OHLC`);
  console.log(`        TPEx: ${tpex.size} 支 (含 OHLC=0 停牌)`);

  type Plan = { symbol: string; action: 'write' | 'halted' | 'no-data'; source?: string; ohlcv?: { open: number; high: number; low: number; close: number; volume: number }; reason?: string };
  const plan: Plan[] = [];

  for (const sym of LEFTOVERS) {
    const code = sym.replace(/\.(TW|TWO)$/i, '');
    if (sym.endsWith('.TW')) {
      const ohlcv = twse.get(code);
      if (ohlcv) {
        plan.push({ symbol: sym, action: 'write', source: 'TWSE MI_INDEX', ohlcv });
      } else {
        plan.push({ symbol: sym, action: 'halted', source: 'TWSE MI_INDEX', reason: '無 OHLC 資料（停牌/未交易）' });
      }
    } else {
      const ohlcv = tpex.get(code);
      if (ohlcv && ohlcv.open > 0 && ohlcv.close > 0) {
        plan.push({ symbol: sym, action: 'write', source: 'TPEx openapi', ohlcv });
      } else if (ohlcv) {
        plan.push({ symbol: sym, action: 'halted', source: 'TPEx openapi', reason: `OHLC=${ohlcv.open}/${ohlcv.high}/${ohlcv.low}/${ohlcv.close}（停牌）` });
      } else {
        plan.push({ symbol: sym, action: 'no-data', reason: 'TPEx 也沒此代號' });
      }
    }
  }

  console.log(`\n計畫：`);
  for (const p of plan) {
    if (p.action === 'write' && p.ohlcv) {
      console.log(`  ${p.symbol.padEnd(10)} WRITE  ${p.source}  o=${p.ohlcv.open} h=${p.ohlcv.high} l=${p.ohlcv.low} c=${p.ohlcv.close} v=${p.ohlcv.volume}`);
    } else {
      console.log(`  ${p.symbol.padEnd(10)} ${p.action.toUpperCase()}  ${p.reason ?? ''}`);
    }
  }

  if (!apply) {
    console.log('\n[dry-run] 加 --apply 來實際寫');
    return;
  }

  let written = 0, failed = 0;
  for (const p of plan) {
    if (p.action !== 'write' || !p.ohlcv) continue;
    try {
      await saveLocalCandles(p.symbol, 'TW', [{ date: TARGET_DATE, ...p.ohlcv }]);
      written++;
    } catch (err) {
      failed++;
      console.warn(`  ${p.symbol} 寫入失敗: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\n[done] 寫入 ${written}, 失敗 ${failed}`);
  const halted = plan.filter(p => p.action === 'halted').map(p => p.symbol);
  if (halted.length > 0) console.log(`[halted/no-trade] ${halted.length} 支: ${halted.join(', ')}`);

  await fs.writeFile(
    'scripts/repair-tw-leftover-5-11-report.json',
    JSON.stringify({ generatedAt: new Date().toISOString(), targetDate: TARGET_DATE, plan }, null, 2),
  );
}

main().catch(err => { console.error(err); process.exit(1); });
