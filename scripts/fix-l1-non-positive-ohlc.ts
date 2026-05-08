/**
 * 修 L1 中 OHLC ≤0 的記錄。
 *
 * 策略：
 *   - 若 close > 0 但 open=0 → 用 (high+low)/2 補 open（接近真實開盤估計）
 *   - 若 high=0 → 用 max(open, close)
 *   - 若 low=0 → 用 min(open, close)
 *   - 全 0 → 直接刪除該 K 棒
 */
import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const CANDLES_ROOT = path.join(REPO_ROOT, 'data', 'candles');

interface Candle { date: string; open: number; high: number; low: number; close: number; volume?: number; }
interface L1File { symbol: string; candles: Candle[]; lastDate?: string; }

async function fixFile(market: 'TW' | 'CN', file: string, dryRun: boolean): Promise<number> {
  const fullPath = path.join(CANDLES_ROOT, market, file);
  const l1: L1File = JSON.parse(await fs.readFile(fullPath, 'utf-8'));
  let fixed = 0;
  const out: Candle[] = [];
  for (const c of l1.candles) {
    const bad = (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0);
    if (!bad) { out.push(c); continue; }
    // 全部 ≤0 → 刪
    if (c.open <= 0 && c.high <= 0 && c.low <= 0 && c.close <= 0) {
      console.log(`  [${market}/${file}] ${c.date} 全 0 → 刪除`);
      fixed++;
      continue;
    }
    const fix: Candle = { ...c };
    if (fix.high <= 0) fix.high = Math.max(fix.open || 0, fix.close || 0);
    if (fix.low <= 0) fix.low = Math.min(fix.open || Number.MAX_VALUE, fix.close || Number.MAX_VALUE);
    if (fix.open <= 0) fix.open = (fix.high + fix.low) / 2;
    if (fix.close <= 0) fix.close = (fix.high + fix.low) / 2;
    console.log(`  [${market}/${file}] ${c.date}: o=${c.open}/${fix.open.toFixed(2)} h=${c.high} l=${c.low} c=${c.close}`);
    out.push(fix);
    fixed++;
  }
  if (fixed > 0 && !dryRun) {
    l1.candles = out;
    if (out.length > 0) l1.lastDate = out[out.length - 1].date;
    await fs.writeFile(fullPath, JSON.stringify(l1));
  }
  return fixed;
}

async function main() {
  const dryRun = !process.argv.includes('--apply');
  console.log(`Mode: ${dryRun ? 'DRY-RUN' : 'WRITE'}\n`);
  let totalFixed = 0;
  for (const market of ['TW', 'CN'] as const) {
    const files = (await fs.readdir(path.join(CANDLES_ROOT, market))).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const n = await fixFile(market, f, dryRun);
        totalFixed += n;
      } catch { /* */ }
    }
  }
  console.log(`\n總修復：${totalFixed} 根 K 棒`);
}

main().catch((e) => { console.error(e); process.exit(1); });
