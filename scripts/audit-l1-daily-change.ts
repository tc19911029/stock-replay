/**
 * 審查 L1 K 棒「單日漲跌幅超過合法漲跌停」的異常
 *
 * TW 一般股：±10%
 * CN 主板：±10%
 * CN 創業板 (30xxxx)：±20%
 * CN 科創板 (688xxx/689xxx)：±20%
 *
 * 「漲跌幅超過合法值」的根因通常是：
 *   1. 缺少中間 K 棒（連續漲停被合併成一根）
 *   2. 數據源未做股利除權調整 vs 我們已調整（或反之）造成跳價
 *   3. 數據源錯標日期 / 股票代碼污染（mislabel）
 *
 * 用法：
 *   tsx scripts/audit-l1-daily-change.ts [--market TW|CN|all] [--top N]
 *
 * 注意：審查的是 ~/Desktop/rockstock/data/candles/，不是 worktree 內的資料夾。
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getLimitMovePct } from '../lib/utils/limitRules';
import type { MarketId } from '../lib/scanner/types';

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

interface Violation {
  symbol: string;
  market: MarketId;
  date: string;
  prevDate: string;
  prevClose: number;
  close: number;
  changePct: number;
  limitPct: number;
  excessPct: number;  // 超出多少
  daysGap: number;    // 與前一根間隔多少日（>1 = 缺 K 棒）
}

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const CANDLES_ROOT = path.join(REPO_ROOT, 'data', 'candles');

// 微小容忍：浮點誤差 + 上市公司公告除權除息近似 → 0.005 (0.5%)
// 真正的污染都遠大於這個值，避免噪音
const TOLERANCE = 0.005;

async function listSymbols(market: MarketId): Promise<string[]> {
  const dir = path.join(CANDLES_ROOT, market);
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

async function loadFile(market: MarketId, file: string): Promise<L1File | null> {
  try {
    const raw = await fs.readFile(path.join(CANDLES_ROOT, market, file), 'utf-8');
    return JSON.parse(raw) as L1File;
  } catch {
    return null;
  }
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(ms / 86400000);
}

function checkFile(market: MarketId, l1: L1File): Violation[] {
  const out: Violation[] = [];
  const limitPct = getLimitMovePct(market, l1.symbol);
  const threshold = limitPct + TOLERANCE;

  for (let i = 1; i < l1.candles.length; i++) {
    const cur = l1.candles[i];
    const prev = l1.candles[i - 1];
    if (!prev || prev.close <= 0 || cur.close <= 0) continue;

    const change = (cur.close - prev.close) / prev.close;
    if (Math.abs(change) <= threshold) continue;

    out.push({
      symbol: l1.symbol,
      market,
      date: cur.date,
      prevDate: prev.date,
      prevClose: prev.close,
      close: cur.close,
      changePct: +(change * 100).toFixed(2),
      limitPct: +(limitPct * 100).toFixed(0),
      excessPct: +((Math.abs(change) - limitPct) * 100).toFixed(2),
      daysGap: daysBetween(prev.date, cur.date),
    });
  }
  return out;
}

async function auditMarket(market: MarketId): Promise<Violation[]> {
  const files = await listSymbols(market);
  console.log(`\n[${market}] 掃描 ${files.length} 檔...`);
  const all: Violation[] = [];
  let processed = 0;
  for (const file of files) {
    const l1 = await loadFile(market, file);
    if (!l1) continue;
    const v = checkFile(market, l1);
    if (v.length > 0) all.push(...v);
    processed++;
    if (processed % 500 === 0) {
      console.log(`  ... ${processed}/${files.length} 已掃，目前 ${all.length} 筆違規`);
    }
  }
  return all;
}

async function main() {
  const args = process.argv.slice(2);
  const marketArg = args.includes('--market')
    ? (args[args.indexOf('--market') + 1] as MarketId | 'all')
    : 'all';
  const topArg = args.includes('--top')
    ? parseInt(args[args.indexOf('--top') + 1], 10)
    : 50;

  const markets: MarketId[] =
    marketArg === 'all' ? ['TW', 'CN'] : marketArg === 'TW' || marketArg === 'CN' ? [marketArg] : [];

  if (markets.length === 0) {
    console.error('Invalid --market value');
    process.exit(1);
  }

  const allViolations: Violation[] = [];
  for (const m of markets) {
    const v = await auditMarket(m);
    allViolations.push(...v);
  }

  // ── 摘要：按 market + daysGap 分桶 ──
  const byMarket = { TW: 0, CN: 0 } as Record<MarketId, number>;
  const byGap = { '1d': 0, '2-7d': 0, '8-30d': 0, '>30d': 0 };
  for (const v of allViolations) {
    byMarket[v.market]++;
    if (v.daysGap === 1) byGap['1d']++;
    else if (v.daysGap <= 7) byGap['2-7d']++;
    else if (v.daysGap <= 30) byGap['8-30d']++;
    else byGap['>30d']++;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`L1 單日漲跌幅違規審查結果（容忍 ±${TOLERANCE * 100}%）`);
  console.log('='.repeat(60));
  console.log(`總違規：${allViolations.length} 筆`);
  console.log(`  TW: ${byMarket.TW}  CN: ${byMarket.CN}`);
  console.log(`  按與前 K 間隔分桶：`);
  console.log(`    1 天（連續日，最可疑）: ${byGap['1d']}`);
  console.log(`    2-7 天（短期缺 K）: ${byGap['2-7d']}`);
  console.log(`    8-30 天（中期缺 K，可能停牌）: ${byGap['8-30d']}`);
  console.log(`    >30 天（IPO 前/長期停牌）: ${byGap['>30d']}`);

  // ── 最嚴重的 N 筆（按 excessPct 排序）──
  const sorted = [...allViolations].sort((a, b) => b.excessPct - a.excessPct);
  console.log(`\n超出限額最多的 Top ${topArg}：`);
  console.log('symbol      market  date         prev→cur close    change   excess  gap');
  console.log('-'.repeat(86));
  for (const v of sorted.slice(0, topArg)) {
    console.log(
      `${v.symbol.padEnd(11)} ${v.market.padEnd(6)} ` +
        `${v.prevDate}→${v.date}  ${v.prevClose.toFixed(2).padStart(8)}→${v.close.toFixed(2).padEnd(8)} ` +
        `${(v.changePct >= 0 ? '+' : '') + v.changePct.toFixed(2)}%  ` +
        `+${v.excessPct.toFixed(2)}%  ${v.daysGap}d`,
    );
  }

  // ── 輸出 JSON 給後續處理 ──
  const outFile = path.join(REPO_ROOT, 'data', 'reports', `l1-daily-change-violations-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), tolerance: TOLERANCE, total: allViolations.length, byMarket, byGap, violations: sorted }, null, 2));
  console.log(`\n完整違規清單已寫入：${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
