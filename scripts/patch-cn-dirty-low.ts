/**
 * 修 CN L1 髒 low（Yahoo 對 A 股偶爾回錯的 low tick）
 *
 * 判定：low < min(open, close) * 0.85（A 股跌停 10%，不可能超過 15%）
 * 修法：low 替換為 max(min(open, close) * 0.9, prevClose * 0.9)
 *        即假設當日 low 最多到跌停板
 */

import { promises as fs } from 'fs';
import path from 'path';

async function main() {
  const dir = path.join('data', 'candles', 'CN');
  const files = await fs.readdir(dir);
  let totalPatched = 0;

  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(dir, f);
    try {
      const j = JSON.parse(await fs.readFile(p, 'utf-8'));
      const c = j.candles as { date: string; open: number; high: number; low: number; close: number; volume: number }[];
      if (!c || c.length === 0) continue;

      let dirty = false;
      for (let i = 0; i < c.length; i++) {
        const x = c[i];
        if (!(x.low > 0 && x.open > 0)) continue;
        const minOC = Math.min(x.open, x.close);
        if (x.low < minOC * 0.85) {
          const prevClose = i > 0 ? c[i - 1].close : minOC;
          // 合理 low：min(O,C) 的 2% 下方，或跌停 10%，取較合理者
          const plausibleLow = Math.max(
            minOC * 0.98,
            prevClose * 0.9,
          );
          x.low = +plausibleLow.toFixed(2);
          dirty = true;
          totalPatched++;
        }
      }

      if (dirty) {
        j.updatedAt = new Date().toISOString();
        await fs.writeFile(p, JSON.stringify(j), 'utf-8');
      }
    } catch { /* skip */ }
  }

  console.log(`已修正 ${totalPatched} 根髒 low K 棒`);
}

main().catch(err => { console.error(err); process.exit(1); });
