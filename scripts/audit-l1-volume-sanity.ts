/**
 * Round 2: L1 volume sanity
 *
 * 檢查：
 *   - volume < 0（不應發生）
 *   - volume = 0 但 close ≠ prev close（vol=0 一字盤之外的異常）
 *   - volume 極大值離群（>average × 100）
 */
import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const CANDLES_ROOT = path.join(REPO_ROOT, 'data', 'candles');

interface RawCandle { date: string; open: number; high: number; low: number; close: number; volume?: number; }
interface L1File { symbol: string; candles: RawCandle[]; }

async function listSymbols(market: 'TW' | 'CN'): Promise<string[]> {
  try { return (await fs.readdir(path.join(CANDLES_ROOT, market))).filter((f) => f.endsWith('.json')); }
  catch { return []; }
}
async function loadFile(market: 'TW' | 'CN', file: string): Promise<L1File | null> {
  try { return JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, market, file), 'utf-8')); }
  catch { return null; }
}

interface V { symbol: string; market: 'TW' | 'CN'; date: string; type: string; detail: string; }

async function main() {
  const all: V[] = [];
  for (const market of ['TW', 'CN'] as const) {
    const files = await listSymbols(market);
    console.log(`[${market}] ${files.length} 檔...`);
    for (const f of files) {
      const l1 = await loadFile(market, f);
      if (!l1) continue;
      const cs = l1.candles;
      // 平均 volume（過去 90 天）
      const recent = cs.slice(-90).filter((c) => (c.volume ?? 0) > 0);
      const avgVol = recent.length > 0 ? recent.reduce((s, c) => s + (c.volume ?? 0), 0) / recent.length : 0;

      for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        const v = c.volume ?? 0;
        if (v < 0) all.push({ symbol: l1.symbol, market, date: c.date, type: 'negative-volume', detail: `${v}` });
        if (v === 0 && i > 0) {
          const p = cs[i - 1];
          if (p.close > 0 && Math.abs(c.close - p.close) / p.close > 0.005) {
            all.push({ symbol: l1.symbol, market, date: c.date, type: 'vol0-but-priced-moved', detail: `prev=${p.close} cur=${c.close}` });
          }
        }
        // 極端離群（>= 100 倍 avg）— 排除 IPO 第一天/復牌
        if (avgVol > 0 && v > avgVol * 100 && i > 5) {
          all.push({ symbol: l1.symbol, market, date: c.date, type: 'volume-outlier-100x', detail: `v=${v} avg=${avgVol.toFixed(0)}` });
        }
      }
    }
  }

  const byType = new Map<string, number>();
  for (const v of all) byType.set(v.type, (byType.get(v.type) ?? 0) + 1);

  console.log(`\n總違規：${all.length} 筆`);
  for (const [t, n] of byType) console.log(`  ${t}: ${n}`);
  console.log(`\nSample:`);
  for (const v of all.slice(0, 10)) console.log(`  ${v.symbol} ${v.market} ${v.date} [${v.type}] ${v.detail}`);

  const out = path.join(REPO_ROOT, 'data', 'reports', `audit-r2-volume-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: all.length, byType: Object.fromEntries(byType), violations: all.slice(0, 200) }, null, 2));
  console.log(`寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
