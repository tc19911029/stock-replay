/**
 * 將前一個 audit 的違規依「嚴重程度」分桶，幫助判斷哪些是 bug、哪些是已知財務動作。
 *
 * 違規分類：
 *   A. 微超 (10–25%, gap=1d) — 最可能是缺 K 棒（連續 2 根漲停被合併）
 *   B. 中超 (25–80%, gap=1d) — 多根漲停被合併 / 不對稱除權調整
 *   C. 大超 (>80%, gap=1d) — 1:N 反向分割 / 重大公司動作
 *   D. 任何超 + gap>1d — 缺 K 棒（停牌、缺日、IPO）
 *
 * 用法：
 *   tsx scripts/audit-l1-violations-classify.ts [--report-path PATH]
 */

import { promises as fs } from 'fs';
import path from 'path';

interface Violation {
  symbol: string;
  market: 'TW' | 'CN';
  date: string;
  prevDate: string;
  prevClose: number;
  close: number;
  changePct: number;
  limitPct: number;
  excessPct: number;
  daysGap: number;
}

interface Report {
  generatedAt: string;
  total: number;
  violations: Violation[];
}

async function main() {
  const args = process.argv.slice(2);
  const reportPath = args.includes('--report-path')
    ? args[args.indexOf('--report-path') + 1]
    : `/Users/tzu-chienhsu/Desktop/rockstock/data/reports/l1-daily-change-violations-${new Date().toISOString().slice(0, 10)}.json`;

  const raw = await fs.readFile(reportPath, 'utf-8');
  const report = JSON.parse(raw) as Report;

  const buckets = {
    'A. 微超 1d (≤25% excess)': [] as Violation[],
    'B. 中超 1d (25-80% excess)': [] as Violation[],
    'C. 大超 1d (>80% excess, 公司動作)': [] as Violation[],
    'D. 缺 K 棒 (gap≥2d)': [] as Violation[],
  };

  for (const v of report.violations) {
    if (v.daysGap >= 2) {
      buckets['D. 缺 K 棒 (gap≥2d)'].push(v);
    } else if (v.excessPct <= 25) {
      buckets['A. 微超 1d (≤25% excess)'].push(v);
    } else if (v.excessPct <= 80) {
      buckets['B. 中超 1d (25-80% excess)'].push(v);
    } else {
      buckets['C. 大超 1d (>80% excess, 公司動作)'].push(v);
    }
  }

  console.log(`Report: ${reportPath}`);
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Total: ${report.total}\n`);
  console.log('='.repeat(60));

  for (const [label, list] of Object.entries(buckets)) {
    const tw = list.filter((v) => v.market === 'TW').length;
    const cn = list.filter((v) => v.market === 'CN').length;
    console.log(`\n${label}: ${list.length} 筆 (TW ${tw} / CN ${cn})`);

    // unique symbols 以及 most-frequent symbol
    const symMap = new Map<string, number>();
    for (const v of list) symMap.set(v.symbol, (symMap.get(v.symbol) ?? 0) + 1);
    const uniqueSymbols = symMap.size;
    const topSyms = [...symMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  unique symbols: ${uniqueSymbols}`);
    console.log(`  most frequent: ${topSyms.map(([s, n]) => `${s}×${n}`).join('  ')}`);

    // sample 3 筆
    if (list.length > 0) {
      console.log(`  sample:`);
      for (const v of list.slice(0, 3)) {
        console.log(
          `    ${v.symbol} ${v.market} ${v.prevDate}→${v.date}  ${v.prevClose.toFixed(2)}→${v.close.toFixed(2)} (${v.changePct >= 0 ? '+' : ''}${v.changePct.toFixed(2)}%, gap=${v.daysGap}d)`,
        );
      }
    }
  }

  // ── A 桶（最可疑 = 缺 K 棒）詳列 ──
  console.log(`\n${'='.repeat(60)}`);
  console.log(`A 桶（連續日且僅微超 → 最可能是缺 K 棒 bug）詳列：`);
  console.log('='.repeat(60));
  const aBucket = buckets['A. 微超 1d (≤25% excess)'].sort((a, b) => b.excessPct - a.excessPct);
  console.log(`共 ${aBucket.length} 筆，按 excessPct 排序：`);
  console.log('symbol      market date         prev→cur close      change%');
  console.log('-'.repeat(74));
  for (const v of aBucket.slice(0, 30)) {
    console.log(
      `${v.symbol.padEnd(11)} ${v.market.padEnd(5)} ` +
        `${v.prevDate}→${v.date}  ${v.prevClose.toFixed(2).padStart(8)}→${v.close.toFixed(2).padEnd(8)} ` +
        `${v.changePct >= 0 ? '+' : ''}${v.changePct.toFixed(2)}%`,
    );
  }
  if (aBucket.length > 30) {
    console.log(`  ... 還有 ${aBucket.length - 30} 筆`);
  }

  // 寫出分類版報告
  const outFile = reportPath.replace('.json', '-classified.json');
  await fs.writeFile(
    outFile,
    JSON.stringify({ generatedAt: report.generatedAt, buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, { count: v.length, items: v }])) }, null, 2),
  );
  console.log(`\n分類版已寫入：${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
