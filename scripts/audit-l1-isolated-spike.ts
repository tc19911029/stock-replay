/**
 * Round 21: 偵測「孤立離群 K 棒」— close 跟前後 K 都差 >50%，但前後彼此正常
 *
 * 例如：
 *   2025-01-09 c=41.20 v=107
 *   2025-01-10 c=4215  v=320  ← 孤立離群（100x）
 *   2025-01-13 c=42    v=278  ← 又回正常
 *
 * 這種 100x off 不會是反向分割（反向分割不會回頭），是純粹的資料源 bug。
 *
 * 修復策略：刪除離群 K 棒（前後 close 互相在 ±5% 內 → 中間異常 → 刪）
 */
import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const CANDLES_ROOT = path.join(REPO_ROOT, 'data', 'candles');

interface Candle { date: string; open: number; high: number; low: number; close: number; volume?: number; }

interface Spike {
  symbol: string;
  market: 'TW' | 'CN';
  date: string;
  prevClose: number;
  spikeClose: number;
  nextClose: number;
  ratioFromPrev: number;
  prevToNextChange: number;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const all: Spike[] = [];

  for (const market of ['TW', 'CN'] as const) {
    const files = (await fs.readdir(path.join(CANDLES_ROOT, market))).filter((f) => f.endsWith('.json'));
    console.log(`[${market}] 掃 ${files.length} 檔...`);
    for (const f of files) {
      try {
        const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, market, f), 'utf-8')) as { symbol: string; candles: Candle[]; lastDate?: string };
        const cs = l1.candles;
        const toRemove: number[] = [];
        for (let i = 1; i < cs.length - 1; i++) {
          const prev = cs[i - 1], cur = cs[i], next = cs[i + 1];
          if (!prev || !cur || !next) continue;
          if (prev.close <= 0 || next.close <= 0 || cur.close <= 0) continue;

          const ratioPrev = cur.close / prev.close;
          const ratioNext = next.close / cur.close;
          const prevToNext = next.close / prev.close;

          // 孤立離群：cur 跟 prev 差 >50%，cur 跟 next 也差 >50%（反向）；但 prev 跟 next 在 ±10% 內
          const isolatedHigh = ratioPrev > 1.5 && ratioNext < 0.7 && Math.abs(prevToNext - 1) < 0.10;
          const isolatedLow = ratioPrev < 0.7 && ratioNext > 1.5 && Math.abs(prevToNext - 1) < 0.10;

          if (isolatedHigh || isolatedLow) {
            all.push({
              symbol: l1.symbol,
              market,
              date: cur.date,
              prevClose: prev.close,
              spikeClose: cur.close,
              nextClose: next.close,
              ratioFromPrev: +ratioPrev.toFixed(3),
              prevToNextChange: +((prevToNext - 1) * 100).toFixed(2),
            });
            toRemove.push(i);
          }
        }
        if (toRemove.length > 0 && apply) {
          const filtered = cs.filter((_, idx) => !toRemove.includes(idx));
          l1.candles = filtered;
          if (filtered.length > 0) l1.lastDate = filtered[filtered.length - 1].date;
          await fs.writeFile(path.join(CANDLES_ROOT, market, f), JSON.stringify(l1));
          console.log(`  ✓ ${l1.symbol}: 移除 ${toRemove.length} 根離群`);
        }
      } catch { /* */ }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`孤立離群 K 棒：${all.length} 筆`);
  for (const s of all.slice(0, 30)) {
    console.log(`  ${s.symbol.padEnd(11)} ${s.market} ${s.date}: prev=${s.prevClose.toFixed(2)} → ${s.spikeClose.toFixed(2)} → ${s.nextClose.toFixed(2)} (prev↔next ${s.prevToNextChange >= 0 ? '+' : ''}${s.prevToNextChange}%)`);
  }
  if (all.length > 30) console.log(`  ... 還有 ${all.length - 30} 筆`);

  const out = path.join(REPO_ROOT, 'data', 'reports', `audit-r21-isolated-spike-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: all.length, mode: apply ? 'APPLIED' : 'DRY-RUN', spikes: all }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
