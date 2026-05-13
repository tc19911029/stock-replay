/**
 * L1 last-trading-day coverage audit
 *
 * 每日跑一次（或臨時呼叫）— 列出 L1 lastDate < 最近交易日的所有股票，
 * 並對外輸出 JSON 給 health snapshot / UI 顯示。
 *
 * 設計動機：2026-05-12 上櫃 stocklist 因 TPEx Cloudflare 阻擋被 abort，
 * 造成 918 檔 L1 沒有 5/12 K → daily scan 把這些股全部精掃跳過 → 鎖漲停股
 * 2377/6225 等被悄悄漏掃。這個 audit 讓「L1 缺最新交易日」明面化、無法
 * 再悄悄漏掉。
 *
 * 用法：
 *   npx tsx scripts/audit-l1-last-day.ts                 — 兩市場掃 + 印 summary
 *   npx tsx scripts/audit-l1-last-day.ts --market TW --json  — 出 JSON 給程式吃
 *   npx tsx scripts/audit-l1-last-day.ts --write data/l1-audit.json
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { getLastTradingDay } from '../lib/datasource/marketHours';

type Market = 'TW' | 'CN';

interface MarketAuditResult {
  market: Market;
  lastTradingDay: string;
  totalFiles: number;
  filesWithData: number;
  missingLastDay: number;
  coverageRate: number;
  lastDateHistogram: Record<string, number>;
  missingSamples: { symbol: string; lastDate: string }[];
}

function auditMarket(market: Market): MarketAuditResult {
  const candleDir = path.join(process.cwd(), 'data', 'candles', market);
  const lastTradingDay = getLastTradingDay(market);
  const out: MarketAuditResult = {
    market,
    lastTradingDay,
    totalFiles: 0,
    filesWithData: 0,
    missingLastDay: 0,
    coverageRate: 0,
    lastDateHistogram: {},
    missingSamples: [],
  };

  if (!existsSync(candleDir)) return out;

  for (const f of readdirSync(candleDir)) {
    if (!f.endsWith('.json')) continue;
    out.totalFiles++;
    const sym = f.replace('.json', '');
    let candles: Array<{ date: string }> = [];
    try {
      const raw = JSON.parse(readFileSync(path.join(candleDir, f), 'utf8'));
      candles = Array.isArray(raw) ? raw : (raw.candles || []);
    } catch { continue; }
    if (candles.length === 0) continue;
    out.filesWithData++;
    const last = candles[candles.length - 1].date;
    out.lastDateHistogram[last] = (out.lastDateHistogram[last] ?? 0) + 1;
    if (last < lastTradingDay) {
      out.missingLastDay++;
      if (out.missingSamples.length < 20) {
        out.missingSamples.push({ symbol: sym, lastDate: last });
      }
    }
  }
  out.coverageRate = out.filesWithData > 0
    ? (out.filesWithData - out.missingLastDay) / out.filesWithData
    : 0;
  return out;
}

interface Args { market?: Market; json: boolean; write?: string; }
function parseArgs(): Args {
  const a: Args = { json: false };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === '--market') a.market = process.argv[++i] as Market;
    else if (x === '--json') a.json = true;
    else if (x === '--write') a.write = process.argv[++i];
  }
  return a;
}

function printSummary(r: MarketAuditResult) {
  console.log(`=== ${r.market} L1 audit ===`);
  console.log(`  最近交易日: ${r.lastTradingDay}`);
  console.log(`  L1 檔案總數: ${r.totalFiles} (有資料 ${r.filesWithData})`);
  console.log(`  缺最近交易日: ${r.missingLastDay} (${((1 - r.coverageRate) * 100).toFixed(1)}%)`);
  const hist = Object.entries(r.lastDateHistogram)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 6);
  console.log(`  lastDate 前 6 名: ${hist.map(([d, n]) => `${d}=${n}`).join(', ')}`);
  if (r.missingSamples.length > 0) {
    console.log(`  缺日樣本（前 ${r.missingSamples.length} 檔）:`);
    r.missingSamples.slice(0, 10).forEach(s =>
      console.log(`    ${s.symbol} @ ${s.lastDate}`));
  }
}

async function main() {
  const args = parseArgs();
  const markets: Market[] = args.market ? [args.market] : ['TW', 'CN'];
  const results = markets.map(auditMarket);

  if (args.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), markets: results }, null, 2));
  } else {
    results.forEach(printSummary);
  }

  if (args.write) {
    const outPath = path.resolve(args.write);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      markets: results,
    }, null, 2));
    console.log(`已寫入 ${outPath}`);
  }

  // exit code：任何市場 coverage < 99% → exit 1（可串到 cron alert）
  const worst = Math.min(...results.map(r => r.coverageRate));
  if (worst < 0.99) {
    console.error(`★ L1 coverage 不足 99% (worst=${(worst * 100).toFixed(1)}%) — exit 1`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(2); });
