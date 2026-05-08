/**
 * Round 23: 移除 L1 開頭連續 vol=0 的假日子（pre-IPO/掛牌前 stub）
 *
 * 規則：cs[0..k] 全部 vol = 0，cs[k+1] 起 vol > 0 → 刪 [0..k]
 *
 * 但保留：若 vol=0 段 < 5 天，認為是中間停牌而非掛牌前。
 */
import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const CANDLES_ROOT = path.join(REPO_ROOT, 'data', 'candles');

interface Candle { date: string; volume?: number; close: number; }

async function main() {
  const apply = process.argv.includes('--apply');
  const findings: Array<{ symbol: string; market: 'TW' | 'CN'; trimmed: number; firstRealDate: string }> = [];

  for (const market of ['TW', 'CN'] as const) {
    const files = (await fs.readdir(path.join(CANDLES_ROOT, market))).filter((f) => f.endsWith('.json'));
    console.log(`[${market}] 掃 ${files.length} 檔...`);
    for (const f of files) {
      try {
        const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, market, f), 'utf-8')) as { symbol: string; candles: Candle[]; lastDate?: string };
        const cs = l1.candles;
        let firstRealIdx = 0;
        while (firstRealIdx < cs.length && (cs[firstRealIdx].volume ?? 0) === 0) {
          firstRealIdx++;
        }
        if (firstRealIdx >= 5 && firstRealIdx < cs.length) {
          findings.push({ symbol: l1.symbol, market, trimmed: firstRealIdx, firstRealDate: cs[firstRealIdx].date });
          if (apply) {
            l1.candles = cs.slice(firstRealIdx);
            await fs.writeFile(path.join(CANDLES_ROOT, market, f), JSON.stringify(l1));
          }
        }
      } catch { /* */ }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`leading vol=0 trim：${findings.length} 支`);
  for (const f of findings.slice(0, 30)) {
    console.log(`  ${f.symbol.padEnd(11)} ${f.market}: trimmed ${f.trimmed} 天，從 ${f.firstRealDate} 開始`);
  }
  if (findings.length > 30) console.log(`  ... 還有 ${findings.length - 30} 支`);

  const out = path.join(REPO_ROOT, 'data', 'reports', `audit-r23-leading-vol0-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: findings.length, mode: apply ? 'APPLIED' : 'DRY-RUN', findings }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
