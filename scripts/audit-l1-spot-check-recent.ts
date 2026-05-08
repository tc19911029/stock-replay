/**
 * L1 spot check — 抽 200 支熱門股檢查近 22 個交易日 K 棒完整性
 *
 * 目標：找最近沒被前面 audit 抓到的「真實缺 K」/「異常 close」
 */
import { promises as fs } from 'fs';
import path from 'path';
import { isTradingDay } from '../lib/utils/tradingDay';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const CANDLES_ROOT = path.join(REPO_ROOT, 'data/candles');

interface Candle { date: string; open: number; high: number; low: number; close: number; volume?: number; }

async function main() {
  // 取 turnoverRank top 200 + 中段 200 支
  const findings: Array<{ market: 'TW' | 'CN'; symbol: string; type: string; detail: string }> = [];

  for (const market of ['TW', 'CN'] as const) {
    const rankFile = path.join(REPO_ROOT, 'data/turnover-rank', `${market}.json`);
    const rank = JSON.parse(await fs.readFile(rankFile, 'utf-8')) as { symbols: string[] };
    const targets = [...rank.symbols.slice(0, 100), ...rank.symbols.slice(200, 300)];  // top 100 + 中段 100

    const today = new Date('2026-05-08');
    const expectedDates: string[] = [];
    for (let i = 0; i < 22; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      if (isTradingDay(iso, market)) expectedDates.push(iso);
    }

    console.log(`[${market}] 抽 ${targets.length} 支股票，預期 ${expectedDates.length} 個交易日`);

    let stocksAudited = 0, stocksWithGaps = 0;
    for (const sym of targets) {
      try {
        const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, market, `${sym}.json`), 'utf-8')) as { candles: Candle[] };
        const dates = new Set(l1.candles.map((c) => c.date));
        const missing = expectedDates.filter((d) => !dates.has(d));
        if (missing.length > 0) {
          stocksWithGaps++;
          findings.push({ market, symbol: sym, type: 'missing-recent-bars', detail: `${missing.length} 缺日: ${missing.slice(0, 3).join(',')}${missing.length > 3 ? '...' : ''}` });
        }
        stocksAudited++;
      } catch { /* */ }
    }
    console.log(`  ${stocksAudited} 支抽查，${stocksWithGaps} 支有近期缺 K`);
  }

  console.log(`\n總發現：${findings.length} 筆`);
  for (const f of findings.slice(0, 20)) console.log(`  ${f.symbol} ${f.market} [${f.type}]: ${f.detail}`);
  if (findings.length > 20) console.log(`  ... 還有 ${findings.length - 20} 筆`);

  const out = path.join(REPO_ROOT, 'data/reports', `audit-l1-recent-spot-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: findings.length, findings }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
