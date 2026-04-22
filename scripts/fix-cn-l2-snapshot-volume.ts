/**
 * fix-cn-l2-snapshot-volume.ts
 *
 * 修復 intraday-CN-*.json 快照中成交量單位（手→股 ×100）
 * 邏輯：比對 L1 前一日成交量，若 < 5% → ×100
 */
import { config } from 'dotenv';
import { existsSync, readdirSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import path from 'path';
import { readFile, writeFile } from 'fs/promises';

const DATA_DIR = path.join(process.cwd(), 'data');
const L1_DIR = path.join(process.cwd(), 'data', 'candles', 'CN');
const DRY_RUN = process.argv.includes('--dry-run');
const RATIO = 0.05;
const MIN_PREV = 10_000;

interface L1Candle { date: string; volume: number; }
interface L2Quote { symbol: string; volume: number; [k: string]: unknown; }
interface L2Snap { market: string; date: string; quotes: L2Quote[]; [k: string]: unknown; }

// Build map: symbol → prev-day volume from L1
async function buildPrevVolMap(snapDate: string): Promise<Map<string, number>> {
  const files = readdirSync(L1_DIR).filter(f => f.endsWith('.json'));
  const map = new Map<string, number>();
  await Promise.all(files.map(async f => {
    try {
      const d = JSON.parse(await readFile(path.join(L1_DIR, f), 'utf-8'));
      const candles: L1Candle[] = d.candles ?? [];
      // find bar just before snapDate
      const idx = candles.findIndex(c => c.date >= snapDate);
      const prevIdx = idx < 0 ? candles.length - 1 : idx - 1;
      if (prevIdx >= 0 && candles[prevIdx].volume > 0) {
        const code = f.replace(/\.(SS|SZ)\.json$/, '');
        map.set(code, candles[prevIdx].volume);
      }
    } catch { /* skip */ }
  }));
  return map;
}

async function fixSnap(filename: string): Promise<void> {
  const filePath = path.join(DATA_DIR, filename);
  const raw = await readFile(filePath, 'utf-8');
  const snap: L2Snap = JSON.parse(raw);
  if (snap.market !== 'CN') return;

  const prevVolMap = await buildPrevVolMap(snap.date);
  let fixed = 0;

  const quotes = snap.quotes.map(q => {
    const prevVol = prevVolMap.get(q.symbol);
    if (prevVol && prevVol >= MIN_PREV && q.volume > 0 && q.volume < prevVol * RATIO) {
      fixed++;
      if (DRY_RUN) {
        console.log(`  [DRY] ${q.symbol} ${snap.date}: ${q.volume} → ${q.volume * 100} (prev=${prevVol})`);
        return q;
      }
      return { ...q, volume: q.volume * 100 };
    }
    return q;
  });

  if (!DRY_RUN && fixed > 0) {
    await writeFile(filePath, JSON.stringify({ ...snap, quotes }), 'utf-8');
  }
  console.log(`${filename}: fixed ${fixed} quotes`);
}

async function main() {
  const snapFiles = readdirSync(DATA_DIR)
    .filter(f => f.match(/^intraday-CN-2026-04-(21|22)\.json$/));

  console.log(`Fixing ${snapFiles.length} L2 CN snapshots (${DRY_RUN ? 'DRY' : 'WRITE'})...`);
  for (const f of snapFiles) await fixSnap(f);
}

main().catch(e => { console.error(e); process.exit(1); });
