/**
 * Round 22: 偵測 pre-IPO/restricted 假資料前綴
 *
 * 模式：
 *   早期一段時間 vol=0 或 vol=1 + 異常高價（10x 後續真實交易價）
 *   後接突然轉成正常交易（vol >= 100, 價格合理）
 *
 * 例：3666.TWO
 *   2021-07-19 c=457000 v=1
 *   ...
 *   2022-05-04 c=209000 v=0
 *   2022-05-05 c=21.65   v=111  ← real trading start
 *
 * 修復：把 first-real-bar 之前的 K 棒全部刪掉
 */
import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const CANDLES_ROOT = path.join(REPO_ROOT, 'data', 'candles');

interface Candle { date: string; open: number; high: number; low: number; close: number; volume?: number; }

async function detectFirstRealBar(cs: Candle[]): Promise<number> {
  // 從第一根開始找連續 vol<10 的段，若該段 max close > 後續 30 天 max close × 5 → 視為 pre-IPO
  if (cs.length < 60) return -1;
  // first 30 days
  let firstNormalIdx = -1;
  for (let i = 30; i < cs.length; i++) {
    // 從 i 起算後 30 根都是 vol >= 50 → 算正常交易區
    let allNormal = true;
    for (let j = 0; j < 30 && i + j < cs.length; j++) {
      if ((cs[i + j].volume ?? 0) < 30) { allNormal = false; break; }
    }
    if (allNormal) { firstNormalIdx = i; break; }
  }
  if (firstNormalIdx < 30) return -1;

  // 看前段 max close 是否 >> 後段 30 天 max close × 5
  const before = cs.slice(0, firstNormalIdx);
  const after = cs.slice(firstNormalIdx, firstNormalIdx + 30);
  const beforeMaxClose = Math.max(...before.map((c) => c.close));
  const afterMaxClose = Math.max(...after.map((c) => c.close));

  // 前段普遍 vol=0/1 → 該段 95% 的 K 棒 vol < 10
  const lowVolPct = before.filter((c) => (c.volume ?? 0) < 10).length / before.length;

  if (lowVolPct > 0.7 && beforeMaxClose > afterMaxClose * 5) {
    return firstNormalIdx;
  }
  return -1;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const findings: Array<{ symbol: string; market: 'TW' | 'CN'; cutAt: number; cutDate: string; preCount: number }> = [];

  for (const market of ['TW', 'CN'] as const) {
    const files = (await fs.readdir(path.join(CANDLES_ROOT, market))).filter((f) => f.endsWith('.json'));
    console.log(`[${market}] 掃 ${files.length} 檔...`);
    for (const f of files) {
      try {
        const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, market, f), 'utf-8')) as { symbol: string; candles: Candle[]; lastDate?: string };
        const cs = l1.candles;
        const cutAt = await detectFirstRealBar(cs);
        if (cutAt > 0) {
          findings.push({ symbol: l1.symbol, market, cutAt, cutDate: cs[cutAt].date, preCount: cutAt });
          if (apply) {
            l1.candles = cs.slice(cutAt);
            await fs.writeFile(path.join(CANDLES_ROOT, market, f), JSON.stringify(l1));
          }
        }
      } catch { /* */ }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`pre-IPO/restricted 前綴：${findings.length} 支`);
  for (const f of findings.slice(0, 30)) {
    console.log(`  ${f.symbol.padEnd(11)} ${f.market}: cut at ${f.cutDate} (preCount=${f.preCount})`);
  }
  if (findings.length > 30) console.log(`  ... 還有 ${findings.length - 30} 支`);

  const out = path.join(REPO_ROOT, 'data', 'reports', `audit-r22-pre-ipo-stub-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: findings.length, mode: apply ? 'APPLIED' : 'DRY-RUN', findings }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
