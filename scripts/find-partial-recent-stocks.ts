/**
 * 列出最近 5 天 K 棒不完整的股票
 */
import { promises as fs } from 'fs';
import path from 'path';
import { isTradingDay } from '../lib/utils/tradingDay';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const CANDLES_ROOT = path.join(REPO_ROOT, 'data/candles');

async function main() {
  const today = new Date('2026-05-08');
  for (const market of ['TW', 'CN'] as const) {
    const expectedDates: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      if (isTradingDay(iso, market)) expectedDates.push(iso);
    }
    const partial: Array<{ sym: string; missing: string[] }> = [];
    const files = (await fs.readdir(path.join(CANDLES_ROOT, market))).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, market, f), 'utf-8')) as { lastDate?: string; candles: { date: string }[] };
        if (!l1.lastDate) continue;
        const daysSince = (today.getTime() - new Date(l1.lastDate).getTime()) / 86400_000;
        if (daysSince > 7) continue;
        const dates = new Set(l1.candles.map((c) => c.date));
        const missing = expectedDates.filter((d) => !dates.has(d));
        if (missing.length > 0 && missing.length < expectedDates.length) {
          partial.push({ sym: f.replace('.json', ''), missing });
        }
      } catch { /* */ }
    }
    console.log(`\n[${market}] ${partial.length} partial stocks:`);
    for (const p of partial.slice(0, 100)) {
      console.log(`  ${p.sym}: 缺 ${p.missing.join(',')}`);
    }
    if (partial.length > 100) console.log(`  ... 還有 ${partial.length - 100} 支`);
    // 寫出股票代號列表
    const out = path.join(REPO_ROOT, `data/reports/partial-stocks-${market}-${new Date().toISOString().slice(0, 10)}.json`);
    await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), expected: expectedDates, partial }, null, 2));
    console.log(`寫入：${out}`);
  }
}

main();
