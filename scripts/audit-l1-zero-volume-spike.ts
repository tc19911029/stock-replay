/**
 * 偵測 L1 中的「假 K 棒」: volume=0 且 close 跳幅 ≥30%
 *
 * 已知污染模式（2026-05-09 4806.TWO 案例）：
 *   2024-10-14  open=27.2  close=27.2  vol=0   ← 前一日 close=13.6
 *   2024-10-23  open=28    close=28    vol=0   ← 前一日 close=14
 *   2024-10-30  open=26.4  close=26.4  vol=0   ← 前一日 close=13.2
 *
 * 推測根因：
 *   - 某資料源在除權除息前後產生重複 K 棒（一根原始價、一根調整價）
 *   - 兩根都被寫入 L1，造成 close 在 +100% 跟 -50% 之間交替震盪
 *
 * 影響：
 *   - scanner 誤判為突破信號
 *   - 走圖看起來像「跳針」
 *   - F V反轉/N 型態確認等更會嚴重誤觸發
 *
 * 修復策略：先報告，再決定是直接刪除 vol=0 的污染 K 棒 vs 從外部源重抓。
 */

import { promises as fs } from 'fs';
import path from 'path';

interface RawCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface L1File {
  symbol: string;
  candles: RawCandle[];
}

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const CANDLES_ROOT = path.join(REPO_ROOT, 'data', 'candles');

interface Pollution {
  symbol: string;
  market: 'TW' | 'CN';
  date: string;
  prevDate: string;
  prevClose: number;
  close: number;
  ratio: number;
  volume: number;
}

async function listSymbols(market: 'TW' | 'CN'): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(CANDLES_ROOT, market))).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

async function loadFile(market: 'TW' | 'CN', file: string): Promise<L1File | null> {
  try {
    const raw = await fs.readFile(path.join(CANDLES_ROOT, market, file), 'utf-8');
    return JSON.parse(raw) as L1File;
  } catch {
    return null;
  }
}

function check(market: 'TW' | 'CN', l1: L1File): Pollution[] {
  const out: Pollution[] = [];
  for (let i = 1; i < l1.candles.length; i++) {
    const cur = l1.candles[i];
    const prev = l1.candles[i - 1];
    if (!cur || !prev || prev.close <= 0 || cur.close <= 0) continue;
    const vol = cur.volume ?? 0;
    if (vol > 0) continue;  // 必須是 vol=0
    const ratio = cur.close / prev.close;
    // close 跳幅 ≥30% 才算（避開正常 vol=0 但價格穩定的暫停日）
    if (Math.abs(ratio - 1) < 0.30) continue;
    out.push({
      symbol: l1.symbol,
      market,
      date: cur.date,
      prevDate: prev.date,
      prevClose: prev.close,
      close: cur.close,
      ratio: +ratio.toFixed(3),
      volume: vol,
    });
  }
  return out;
}

async function main() {
  const all: Pollution[] = [];
  for (const market of ['TW', 'CN'] as const) {
    const files = await listSymbols(market);
    console.log(`\n[${market}] 掃描 ${files.length} 檔...`);
    let processed = 0;
    for (const file of files) {
      const l1 = await loadFile(market, file);
      if (!l1) continue;
      const p = check(market, l1);
      if (p.length > 0) all.push(...p);
      processed++;
      if (processed % 1000 === 0) {
        console.log(`  ... ${processed}/${files.length}, 目前 ${all.length} 筆假 K 棒`);
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`vol=0 + close 跳幅 ≥30% 假 K 棒：${all.length} 筆`);
  console.log('='.repeat(60));

  // 按股票分組
  const bySym = new Map<string, Pollution[]>();
  for (const p of all) {
    if (!bySym.has(p.symbol)) bySym.set(p.symbol, []);
    bySym.get(p.symbol)!.push(p);
  }

  console.log(`unique symbols: ${bySym.size}`);
  console.log(`受污染最多的 Top 20：`);
  const top = [...bySym.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20);
  for (const [sym, list] of top) {
    const dates = list.map((p) => p.date.slice(5)).join(', ');
    console.log(`  ${sym.padEnd(12)} ${list.length} 筆: ${dates}`);
  }

  // 寫出修復清單
  const outFile = path.join(REPO_ROOT, 'data', 'reports', `l1-zero-volume-spike-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: all.length,
    bySymbol: Object.fromEntries([...bySym.entries()].map(([k, v]) => [k, v])),
  }, null, 2));
  console.log(`\n清單已寫入：${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
