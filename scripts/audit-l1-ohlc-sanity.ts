/**
 * Round 1: L1 OHLC sanity 檢查
 *
 * 檢查每根 K 棒的 OHLC 邏輯：
 *   - high < open / high < close / high < low → 違規
 *   - low > open / low > close / low > high → 違規
 *   - 任一值 ≤ 0 或 NaN → 違規
 *
 * CN 因集合競價 +TW 除權調整，少量 close>high/low<close 是已知例外（≤0.5% 容忍）
 */

import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const CANDLES_ROOT = path.join(REPO_ROOT, 'data', 'candles');
const TOLERANCE_RATIO = 0.005;  // 0.5%

interface RawCandle { date: string; open: number; high: number; low: number; close: number; volume?: number; }
interface L1File { symbol: string; candles: RawCandle[]; }

interface Violation { symbol: string; market: 'TW' | 'CN'; date: string; type: string; values: string; }

async function listSymbols(market: 'TW' | 'CN'): Promise<string[]> {
  try { return (await fs.readdir(path.join(CANDLES_ROOT, market))).filter((f) => f.endsWith('.json')); }
  catch { return []; }
}
async function loadFile(market: 'TW' | 'CN', file: string): Promise<L1File | null> {
  try { return JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, market, file), 'utf-8')); }
  catch { return null; }
}

function check(market: 'TW' | 'CN', l1: L1File): Violation[] {
  const out: Violation[] = [];
  for (const c of l1.candles) {
    const v = `o=${c.open} h=${c.high} l=${c.low} c=${c.close}`;
    if (![c.open, c.high, c.low, c.close].every((x) => typeof x === 'number' && !Number.isNaN(x))) {
      out.push({ symbol: l1.symbol, market, date: c.date, type: 'NaN/non-number', values: v });
      continue;
    }
    if ([c.open, c.high, c.low, c.close].some((x) => x <= 0)) {
      out.push({ symbol: l1.symbol, market, date: c.date, type: 'non-positive', values: v });
      continue;
    }
    if (c.high < c.low) out.push({ symbol: l1.symbol, market, date: c.date, type: 'high<low', values: v });
    // close 超出 high/low 範圍（容忍）
    if (c.close > c.high * (1 + TOLERANCE_RATIO))
      out.push({ symbol: l1.symbol, market, date: c.date, type: 'close>high', values: v });
    if (c.close < c.low * (1 - TOLERANCE_RATIO))
      out.push({ symbol: l1.symbol, market, date: c.date, type: 'close<low', values: v });
    // open 超出 high/low 範圍（容忍）
    if (c.open > c.high * (1 + TOLERANCE_RATIO))
      out.push({ symbol: l1.symbol, market, date: c.date, type: 'open>high', values: v });
    if (c.open < c.low * (1 - TOLERANCE_RATIO))
      out.push({ symbol: l1.symbol, market, date: c.date, type: 'open<low', values: v });
  }
  return out;
}

async function main() {
  const all: Violation[] = [];
  for (const market of ['TW', 'CN'] as const) {
    const files = await listSymbols(market);
    console.log(`[${market}] 掃 ${files.length} 檔...`);
    for (const f of files) {
      const l1 = await loadFile(market, f);
      if (l1) all.push(...check(market, l1));
    }
  }

  const byType = new Map<string, number>();
  for (const v of all) byType.set(v.type, (byType.get(v.type) ?? 0) + 1);

  console.log(`\n總違規：${all.length} 筆`);
  for (const [t, n] of byType) console.log(`  ${t}: ${n}`);
  console.log(`\nSample 10:`);
  for (const v of all.slice(0, 10)) console.log(`  ${v.symbol} ${v.market} ${v.date} [${v.type}] ${v.values}`);

  const out = path.join(REPO_ROOT, 'data', 'reports', `audit-r1-ohlc-sanity-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: all.length, byType: Object.fromEntries(byType), violations: all }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
