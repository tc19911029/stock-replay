/**
 * 買法偵測統一驗證腳本（Phase 1~5 共用，2026-04-20 rename 後）
 *
 * Usage:
 *   npx tsx scripts/scan-buy-method.ts <B|C|D|E|F|G|H> <TW|CN> <YYYY-MM-DD>
 *
 * 字母對照：
 *   B=回後買上漲、C=盤整突破、D=一字底、E=缺口、F=V形反轉
 *   G=ABC 突破（寶典 Part 11-1 位置 6，2026-05-04 新增）
 *   H=突破大量黑 K（寶典 Part 11-1 位置 8，2026-05-04 新增）
 *
 * 例：
 *   npx tsx scripts/scan-buy-method.ts E TW 2026-04-08  # 台積電 4/8 跳空（缺口）
 *   npx tsx scripts/scan-buy-method.ts D TW 2026-04-17  # 一字底突破
 *   npx tsx scripts/scan-buy-method.ts B CN 2026-04-17  # 回後買上漲
 *   npx tsx scripts/scan-buy-method.ts F TW 2026-04-17  # V 形反轉
 *   npx tsx scripts/scan-buy-method.ts G TW 2026-05-03  # ABC 突破
 *   npx tsx scripts/scan-buy-method.ts H TW 2026-05-03  # 突破大量黑 K
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectBreakoutEntry, detectConsolidationBreakout } from '@/lib/analysis/breakoutEntry';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';
import { detectABCBreakout } from '@/lib/analysis/abcBreakoutEntry';
import { detectBlackKBreakout } from '@/lib/analysis/blackKBreakoutEntry';
import type { CandleWithIndicators } from '@/types';

type Method = 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

const method = (process.argv[2] ?? 'D').toUpperCase() as Method;
const market = (process.argv[3] ?? 'TW').toUpperCase() as 'TW' | 'CN';
const date   = process.argv[4] ?? '2026-04-17';

const METHOD_NAMES: Record<Method, string> = {
  B: '回後買上漲',
  C: '盤整突破',
  D: '一字底突破',
  E: '缺口進場',
  F: 'V 形反轉',
  G: 'ABC 突破',
  H: '突破大量黑 K',
};

interface Hit {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  detail: string;
}

function loadDir(market: 'TW' | 'CN'): Array<{ symbol: string; name: string; candles: CandleWithIndicators[] }> {
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  if (!fs.existsSync(dir)) { console.error('L1 目錄不存在：' + dir); return []; }
  const all: Array<{ symbol: string; name: string; candles: CandleWithIndicators[] }> = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const c: CandleWithIndicators[] = Array.isArray(raw) ? raw : raw.candles ?? raw;
      if (!c || c.length < 11) continue;
      const name = (raw as { name?: string }).name ?? f.replace('.json', '');
      all.push({ symbol: f.replace('.json', ''), name, candles: computeIndicators(c) });
    } catch { /* ignore */ }
  }
  return all;
}

function runDetector(method: Method, candles: CandleWithIndicators[], idx: number): string | null {
  switch (method) {
    case 'B': {
      const r = detectBreakoutEntry(candles, idx);
      return r?.isBreakout ? r.detail : null;
    }
    case 'C': {
      const r = detectConsolidationBreakout(candles, idx);
      return r?.isBreakout ? r.detail : null;
    }
    case 'D': {
      const r = detectStrategyE(candles, idx);
      return r?.isFlatBottom ? r.detail : null;
    }
    case 'E': {
      const r = detectStrategyD(candles, idx);
      return r?.isGapEntry ? r.detail : null;
    }
    case 'F': {
      const r = detectVReversal(candles, idx);
      return r?.isVReversal ? r.detail : null;
    }
    case 'G': {
      const r = detectABCBreakout(candles, idx);
      return r?.isABCBreakout ? r.detail : null;
    }
    case 'H': {
      const r = detectBlackKBreakout(candles, idx);
      return r?.isBlackKBreakout ? r.detail : null;
    }
  }
}

function main() {
  if (!(['B', 'C', 'D', 'E', 'F', 'G', 'H'] as Method[]).includes(method)) {
    console.error('買法必須是 B/C/D/E/F/G/H');
    process.exit(1);
  }

  console.log(`\n${METHOD_NAMES[method]} 偵測：${market} ${date}\n`);
  process.stdout.write('  讀取 L1...');
  const stocks = loadDir(market);
  console.log(` ${stocks.length} 支`);

  const hits: Hit[] = [];
  for (const { symbol, name, candles } of stocks) {
    const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
    if (idx < 0) continue;

    const detail = runDetector(method, candles, idx);
    if (!detail) continue;

    const c = candles[idx];
    const prev = candles[idx - 1];
    const changePercent = prev && prev.close > 0 ? (c.close - prev.close) / prev.close * 100 : 0;
    hits.push({ symbol, name, price: c.close, changePercent, detail });
  }

  hits.sort((a, b) => b.changePercent - a.changePercent);

  console.log(`\n符合 ${METHOD_NAMES[method]}：${hits.length} 支\n`);
  if (hits.length === 0) {
    console.log('  （無）\n');
    return;
  }
  for (const h of hits.slice(0, 50)) {
    console.log(
      `  ${h.symbol.padEnd(8)} ${h.name.padEnd(18)} 收${h.price.toFixed(2).padStart(7)}  ${(h.changePercent.toFixed(2) + '%').padStart(7)}  ${h.detail}`,
    );
  }
  if (hits.length > 50) console.log(`\n  （僅顯示前 50 支，共 ${hits.length}）`);
  console.log('');
}

main();
