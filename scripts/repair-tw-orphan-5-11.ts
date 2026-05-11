/**
 * Mop-up：補 lastDate < 5/11 但 stocklist 漏掉的 .TWO（TPEx 漏 fetch）
 *          + .TW 的 ETF / 00xx 系列（已被 ETF 腳本處理）
 *          + ^TWII 不處理（指數另外有 cron）
 *
 * 用法：npx tsx scripts/repair-tw-orphan-5-11.ts [--apply]
 */

import { promises as fs } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';

const TARGET_DATE = '2026-05-11';
const REPORT_FILE = path.join(process.cwd(), 'scripts', 'find-tw-missing-today-report.json');

interface BulkOHLCV { open: number; high: number; low: number; close: number; volume: number; }

async function fetchTPExBulk(dateStr: string): Promise<Map<string, BulkOHLCV>> {
  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes';
  const stdout = execFileSync('curl', ['-s', '--max-time', '30', '-A', 'Mozilla/5.0', url], { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
  const rows = JSON.parse(stdout) as Array<Record<string, string>>;
  const parseROC = (raw: string) => {
    const m = raw.match(/^(\d{3})(\d{2})(\d{2})$/);
    if (!m) return null;
    return `${parseInt(m[1], 10) + 1911}-${m[2]}-${m[3]}`;
  };
  const parseNum = (s?: string) => { if (!s) return 0; const n = parseFloat((s ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const map = new Map<string, BulkOHLCV>();
  for (const row of rows) {
    if (parseROC(row.Date ?? '') !== dateStr) continue;
    const code = (row.SecuritiesCompanyCode ?? '').trim();
    if (!code) continue;
    const open = parseNum(row.Open);
    const high = parseNum(row.High);
    const low = parseNum(row.Low);
    const close = parseNum(row.Close);
    const volume = Math.round(parseNum(row.TradingShares) / 1000);
    if (open > 0 && close > 0) map.set(code, { open, high, low, close, volume });
  }
  return map;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const report = JSON.parse(await fs.readFile(REPORT_FILE, 'utf-8')) as { missing: Array<{ symbol: string; inStocklist: boolean }> };
  // 非 stocklist 但 .TWO（孤兒）
  const targets = report.missing.filter(m => !m.inStocklist && m.symbol.endsWith('.TWO'));
  console.log(`[load] 非 stocklist .TWO 孤兒: ${targets.length} 支`);
  if (targets.length === 0) return;

  console.log(`[fetch] TPEx openapi ...`);
  const tpex = await fetchTPExBulk(TARGET_DATE);
  console.log(`        TPEx 載入 ${tpex.size} 支 (OHLC > 0)`);

  type Plan = { symbol: string; action: 'write' | 'no-data'; ohlcv?: BulkOHLCV };
  const plan: Plan[] = [];
  for (const t of targets) {
    const code = t.symbol.replace(/\.TWO$/i, '');
    const ohlcv = tpex.get(code);
    if (ohlcv) plan.push({ symbol: t.symbol, action: 'write', ohlcv });
    else plan.push({ symbol: t.symbol, action: 'no-data' });
  }
  const writes = plan.filter(p => p.action === 'write');
  const noData = plan.filter(p => p.action === 'no-data');
  console.log(`[plan] write=${writes.length}, no-data=${noData.length}`);
  if (noData.length > 0) {
    console.log(`        no-data (TPEx 無 5/11 OHLC > 0 → 停牌/退市): ${noData.map(p => p.symbol).join(', ')}`);
  }

  if (!apply) { console.log('\n[dry-run]'); return; }

  let written = 0;
  for (const p of writes) {
    if (!p.ohlcv) continue;
    try {
      await saveLocalCandles(p.symbol, 'TW', [{ date: TARGET_DATE, ...p.ohlcv }]);
      written++;
    } catch (err) {
      console.warn(`  ${p.symbol} 失敗: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`[done] 寫 ${written}`);
}

main().catch(err => { console.error(err); process.exit(1); });
