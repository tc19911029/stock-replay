/**
 * 廣域抽查 — 每市場 1000 支股票（top 500 + 隨機 500）查近期缺 K
 */
import { promises as fs } from 'fs';
import path from 'path';
import { isTradingDay } from '../lib/utils/tradingDay';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';

async function main() {
  const today = new Date('2026-05-08');
  for (const market of ['TW', 'CN'] as const) {
    const expected: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      if (isTradingDay(iso, market)) expected.push(iso);
    }
    const rank = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'data/turnover-rank', `${market}.json`), 'utf-8')) as { symbols: string[] };
    const allFiles = (await fs.readdir(path.join(REPO_ROOT, 'data/candles', market))).filter((f) => f.endsWith('.json'));
    // top 500 + 隨機 500
    const random500 = allFiles.sort(() => Math.random() - 0.5).slice(0, 500).map((f) => f.replace('.json', ''));
    const targets = Array.from(new Set([...rank.symbols.slice(0, 500), ...random500]));
    console.log(`[${market}] ${targets.length} 支抽查，預期 ${expected.length} 個交易日`);
    let ok = 0, gap = 0, stale = 0, partials: string[] = [];
    for (const sym of targets) {
      try {
        const l1 = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'data/candles', market, `${sym}.json`), 'utf-8')) as { lastDate?: string; candles: { date: string }[] };
        if (!l1.lastDate) continue;
        const daysSince = (today.getTime() - new Date(l1.lastDate).getTime()) / 86400_000;
        if (daysSince > 7) { stale++; continue; }
        const dates = new Set(l1.candles.map((c) => c.date));
        const missing = expected.filter((d) => !dates.has(d));
        if (missing.length === 0) ok++;
        else { gap++; if (partials.length < 50) partials.push(`${sym}缺${missing.length}`); }
      } catch { /* */ }
    }
    console.log(`  完整 ${ok} / 缺 ${gap} / stale ${stale}`);
    if (gap > 0) console.log(`  partial: ${partials.slice(0, 20).join(', ')}${partials.length > 20 ? '...' : ''}`);
  }
}
main();
