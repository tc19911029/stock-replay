/**
 * 廣域 L1 spot check — 全部市場股票檢查最近 5 個交易日
 *
 * 比 spot-check-recent 更廣（檢查所有 1986 TW + 3088 CN）
 * 但只檢查 5 天（避免長期停牌的雜訊）
 */
import { promises as fs } from 'fs';
import path from 'path';
import { isTradingDay } from '../lib/utils/tradingDay';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const CANDLES_ROOT = path.join(REPO_ROOT, 'data/candles');

interface Candle { date: string; close: number; volume?: number; }

async function main() {
  const today = new Date('2026-05-08');
  for (const market of ['TW', 'CN'] as const) {
    const expectedDates: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      if (isTradingDay(iso, market)) expectedDates.push(iso);
    }
    console.log(`\n[${market}] 預期最近 ${expectedDates.length} 天: ${expectedDates.join(', ')}`);

    const files = (await fs.readdir(path.join(CANDLES_ROOT, market))).filter((f) => f.endsWith('.json'));
    let active = 0, allComplete = 0, partial = 0, stale = 0, missing = 0;
    for (const f of files) {
      try {
        const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, market, f), 'utf-8')) as { lastDate?: string; candles: Candle[] };
        if (!l1.lastDate) continue;
        // 視為 "active" 若 lastDate >= 7 days ago
        const daysSinceLast = (today.getTime() - new Date(l1.lastDate).getTime()) / 86400_000;
        if (daysSinceLast > 7) {
          stale++;
          continue;
        }
        active++;
        const dates = new Set(l1.candles.map((c) => c.date));
        const present = expectedDates.filter((d) => dates.has(d)).length;
        if (present === expectedDates.length) allComplete++;
        else if (present > 0) partial++;
        else missing++;
      } catch { /* */ }
    }
    console.log(`  active (≤7d): ${active}, all-complete: ${allComplete} (${((100 * allComplete / Math.max(1, active))).toFixed(1)}%)`);
    console.log(`    partial: ${partial}, missing-recent: ${missing}, stale (>7d): ${stale}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
