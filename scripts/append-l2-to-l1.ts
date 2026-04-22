/**
 * append-l2-to-l1.ts — 從本地 L2 快照補 L1 今日 K 棒
 * 用法：npx tsx scripts/append-l2-to-l1.ts [TW|CN]
 */
import { config } from 'dotenv';
import { existsSync, readdirSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import path from 'path';
import { readFile, writeFile } from 'fs/promises';

const market = (process.argv[2] ?? 'CN') as 'TW' | 'CN';
const DATA_DIR = path.join(process.cwd(), 'data');
const L1_DIR = path.join(DATA_DIR, 'candles', market);

// Find today's L2 snapshot
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
}).format(new Date());

const snapFile = path.join(DATA_DIR, `intraday-${market}-${today}.json`);
if (!existsSync(snapFile)) {
  console.error(`L2 快照不存在: ${snapFile}`);
  process.exit(1);
}

interface L2Quote { symbol: string; open: number; high: number; low: number; close: number; volume: number; }
interface L2Snap { date: string; quotes: L2Quote[]; }
interface L1Candle { date: string; open: number; high: number; low: number; close: number; volume: number; }
interface L1File { candles: L1Candle[]; lastDate?: string; [k: string]: unknown; }

function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 新 bar 與歷史中位數相差 >30 倍 → 單位不一致，拒絕寫入 */
function isVolumeAnomalous(candles: L1Candle[], newVol: number): false | string {
  if (newVol <= 0 || candles.length < 5) return false;
  const window = candles.slice(-20).map(c => c.volume).filter(v => v > 0);
  if (window.length < 5) return false;
  const med = medianOf(window);
  if (med <= 0) return false;
  if (newVol > med * 30) return `新bar量(${newVol}) > 歷史中位數(${med})×30 → 可能手→股單位錯誤，先跑 normalize-cn-l1-volume.ts`;
  if (newVol < med / 30) return `新bar量(${newVol}) < 歷史中位數(${med})/30 → 可能股→手單位錯誤`;
  return false;
}

async function main() {
  const snap: L2Snap = JSON.parse(await readFile(snapFile, 'utf-8'));
  const quotes = snap.quotes.filter(q => q.close > 0);
  console.log(`L2 快照 ${snap.date}：${quotes.length} 筆有效報價`);

  const suffix = market === 'TW' ? '.TW' : market === 'CN' ? '' : '';
  const ext = market === 'CN' ? '.SS' : ''; // will handle below

  let appended = 0, skipped = 0, missing = 0;

  const files = readdirSync(L1_DIR).filter(f => f.endsWith('.json'));
  const fileMap = new Map(files.map(f => {
    const code = f.replace(/\.(TW|TWO|SS|SZ)\.json$/, '');
    return [code, f];
  }));

  await Promise.all(quotes.map(async q => {
    const fname = fileMap.get(q.symbol);
    if (!fname) { missing++; return; }

    const fpath = path.join(L1_DIR, fname);
    try {
      const raw = JSON.parse(await readFile(fpath, 'utf-8')) as L1File;
      const candles = raw.candles ?? [];
      const last = candles[candles.length - 1];
      if (last?.date === snap.date) { skipped++; return; }

      const anomaly = isVolumeAnomalous(candles, q.volume);
      if (anomaly) {
        console.warn(`  [SKIP] ${q.symbol} ${snap.date}: ${anomaly}`);
        missing++;
        return;
      }

      candles.push({ date: snap.date, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
      raw.candles = candles;
      raw.lastDate = snap.date;
      await writeFile(fpath, JSON.stringify(raw), 'utf-8');
      appended++;
    } catch { missing++; }
  }));

  console.log(`完成：appended=${appended}, skipped(已有)=${skipped}, missing(無L1)=${missing}`);
}

main().catch(e => { console.error(e); process.exit(1); });
