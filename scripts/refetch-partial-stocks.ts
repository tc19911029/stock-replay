/**
 * 對近期缺 K 的 partial 股票批次重抓（TW + CN）
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { isTradingDay } from '../lib/utils/tradingDay';
import { twseHistProvider } from '../lib/datasource/TWSEHistProvider';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';

interface Candle { date: string; open: number; high: number; low: number; close: number; volume?: number; }

async function refetchTW(sym: string, expected: string[]): Promise<{ ok: boolean; reason: string }> {
  try {
    const candles = await twseHistProvider.getHistoricalCandles(sym, '1y');
    if (!candles || candles.length < 30) return { ok: false, reason: '太少' };
    const filePath = path.join(REPO_ROOT, 'data/candles/TW', `${sym}.json`);
    let oldCandles: Candle[] = [];
    try {
      oldCandles = (JSON.parse(await fs.readFile(filePath, 'utf-8')) as { candles: Candle[] }).candles;
    } catch { /* */ }
    const newDates = new Set(candles.map((c) => c.date));
    const oneYearAgo = candles[0].date;
    const merged = [
      ...oldCandles.filter((c) => c.date < oneYearAgo && !newDates.has(c.date)),
      ...candles.map((c) => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const out = { symbol: sym, lastDate: merged[merged.length - 1].date, updatedAt: new Date().toISOString(), candles: merged, sealedDate: merged[merged.length - 1].date };
    await fs.writeFile(filePath, JSON.stringify(out));
    const dates = new Set(merged.map((c) => c.date));
    const stillMissing = expected.filter((d) => !dates.has(d));
    return { ok: stillMissing.length === 0, reason: stillMissing.length === 0 ? `complete (${oldCandles.length}→${merged.length})` : `still缺${stillMissing.length}` };
  } catch (err) {
    return { ok: false, reason: String(err).slice(0, 60) };
  }
}

async function refetchCN(scanner: ChinaScanner, sym: string, expected: string[]): Promise<{ ok: boolean; reason: string }> {
  try {
    const candles = await scanner.fetchCandles(sym);
    if (!candles || candles.length < 30) return { ok: false, reason: '太少' };
    const filePath = path.join(REPO_ROOT, 'data/candles/CN', `${sym}.json`);
    let oldCandles: Candle[] = [];
    try {
      oldCandles = (JSON.parse(await fs.readFile(filePath, 'utf-8')) as { candles: Candle[] }).candles;
    } catch { /* */ }
    const newDates = new Set(candles.map((c) => c.date));
    const oneYearAgo = candles[0].date;
    const merged = [
      ...oldCandles.filter((c) => c.date < oneYearAgo && !newDates.has(c.date)),
      ...candles.map((c) => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const out = { symbol: sym, lastDate: merged[merged.length - 1].date, updatedAt: new Date().toISOString(), candles: merged, sealedDate: merged[merged.length - 1].date };
    await fs.writeFile(filePath, JSON.stringify(out));
    const dates = new Set(merged.map((c) => c.date));
    const stillMissing = expected.filter((d) => !dates.has(d));
    return { ok: stillMissing.length === 0, reason: stillMissing.length === 0 ? `complete (${oldCandles.length}→${merged.length})` : `still缺${stillMissing.length}` };
  } catch (err) {
    return { ok: false, reason: String(err).slice(0, 60) };
  }
}

async function main() {
  const today = new Date('2026-05-08');
  for (const market of ['TW', 'CN'] as const) {
    const expected: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      if (isTradingDay(iso, market)) expected.push(iso);
    }
    // 找出 partial 股票
    const allFiles = (await fs.readdir(path.join(REPO_ROOT, 'data/candles', market))).filter((f) => f.endsWith('.json'));
    const partials: string[] = [];
    for (const f of allFiles) {
      try {
        const l1 = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'data/candles', market, f), 'utf-8')) as { lastDate?: string; candles: { date: string }[] };
        if (!l1.lastDate) continue;
        const daysSince = (today.getTime() - new Date(l1.lastDate).getTime()) / 86400_000;
        if (daysSince > 7) continue;
        const dates = new Set(l1.candles.map((c) => c.date));
        const missing = expected.filter((d) => !dates.has(d));
        if (missing.length > 0 && missing.length < expected.length) {
          partials.push(f.replace('.json', ''));
        }
      } catch { /* */ }
    }
    console.log(`\n[${market}] 找到 ${partials.length} 支 partial`);
    let recovered = 0, failed = 0;
    const cnScanner = market === 'CN' ? new ChinaScanner() : null;
    for (const sym of partials) {
      const r = market === 'TW'
        ? await refetchTW(sym, expected)
        : await refetchCN(cnScanner!, sym, expected);
      if (r.ok) recovered++;
      else failed++;
      if (recovered + failed <= 10) console.log(`  ${sym}: ${r.ok ? '✓' : '✗'} ${r.reason}`);
    }
    console.log(`  recovered ${recovered} / failed ${failed} (剩餘 ${failed} 應為真實停牌)`);
  }
}
main();
