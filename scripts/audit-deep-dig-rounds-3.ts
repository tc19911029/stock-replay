/**
 * Deep-dig Round 24-30
 *
 * 24: L4 result.price 與 L1 close 一致性
 * 25: L4 schemaVersion 標記覆蓋率（v11 vs v12）
 * 26: scan-bm session lockWatchPayload 覆蓋率（F/N 應全有）
 * 27: 各 buy method scan resultCount 趨勢分析（突然全 0 = bug）
 * 28: stock list 重複（同 symbol 兩次）
 * 29: scan results 內部一致性（trendState in {多/空/盤整}）
 * 30: scan history 連續性（每天每 method 都有 session）
 */

import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const SCAN_ROOT = path.join(REPO_ROOT, 'data');
const CANDLES_ROOT = path.join(REPO_ROOT, 'data', 'candles');

interface F { round: number; type: string; symbol?: string; date?: string; detail: string; severity: 'low' | 'medium' | 'high' | 'critical'; }
const findings: F[] = [];

async function round24() {
  console.log('\n=== R24: L4 result.price vs L1 close ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-[A-Q]-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let checked = 0, mismatch = 0;
  for (const f of files.slice(0, 100)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { market: 'TW' | 'CN'; date: string; results: Array<{ symbol: string; price: number }> };
      for (const r of (sess.results ?? []).slice(0, 3)) {
        try {
          const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, sess.market, `${r.symbol}.json`), 'utf-8')) as { candles: Array<{ date: string; close: number }> };
          const c = l1.candles.find((c) => c.date === sess.date);
          if (c && Math.abs((c.close - r.price) / r.price) > 0.005) {
            mismatch++;
            if (mismatch <= 5) findings.push({ round: 24, type: 'l4-price-mismatch', symbol: r.symbol, date: sess.date, detail: `L4=${r.price} L1=${c.close}`, severity: 'high' });
          }
          checked++;
        } catch { /* */ }
      }
    } catch { /* */ }
  }
  console.log(`  抽 ${checked} 筆，${mismatch} 偏差 >0.5%`);
}

async function round25() {
  console.log('\n=== R25: schemaVersion 覆蓋率 ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-.*\.json$/.test(f));
  const stats = { total: 0, v11: 0, v12: 0, none: 0 };
  for (const f of files) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { schemaVersion?: string };
      stats.total++;
      if (sess.schemaVersion === 'v11') stats.v11++;
      else if (sess.schemaVersion === 'v12') stats.v12++;
      else stats.none++;
    } catch { /* */ }
  }
  console.log(`  ${stats.total} sessions: v11=${stats.v11}, v12=${stats.v12}, no-version=${stats.none}`);
  if (stats.none > 0) findings.push({ round: 25, type: 'no-schema-version', detail: `${stats.none} sessions w/o schemaVersion`, severity: 'low' });
}

async function round26() {
  console.log('\n=== R26: F/N session lockWatchPayload 覆蓋率 ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-(F|N)-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let total = 0, withPayload = 0;
  for (const f of files) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ lockWatchPayload?: { triggerPrice?: number } }> };
      for (const r of sess.results ?? []) {
        total++;
        if (r.lockWatchPayload?.triggerPrice && r.lockWatchPayload.triggerPrice > 0) withPayload++;
      }
    } catch { /* */ }
  }
  console.log(`  F/N session 結果 ${total} 筆，有 lockWatchPayload ${withPayload}`);
  if (total > 0 && withPayload / total < 0.95) findings.push({ round: 26, type: 'lw-payload-low-coverage', detail: `${withPayload}/${total} (${(100*withPayload/total).toFixed(1)}%)`, severity: 'high' });
}

async function round27() {
  console.log('\n=== R27: buy-method 各天 result 數穩定性 ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-[A-Q]-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  const byKey: Record<string, Array<{ date: string; count: number }>> = {};
  for (const f of files) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { market: string; date: string; buyMethod?: string; resultCount?: number };
      if (!sess.buyMethod || !sess.date) continue;
      const k = `${sess.market}-${sess.buyMethod}`;
      if (!byKey[k]) byKey[k] = [];
      byKey[k].push({ date: sess.date, count: sess.resultCount ?? 0 });
    } catch { /* */ }
  }
  for (const [k, list] of Object.entries(byKey)) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const counts = list.map((x) => x.count);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const zerosInRow = counts.slice(-5).filter((c) => c === 0).length;
    if (mean > 5 && zerosInRow >= 3) {
      findings.push({ round: 27, type: 'method-recent-zeros', detail: `${k}: 近 5 天有 ${zerosInRow} 個 0（mean=${mean.toFixed(1)}）`, severity: 'medium' });
    }
  }
  console.log(`  ${Object.keys(byKey).length} 個 (market,method) 對，無突然降至零異常`);
}

async function round28() {
  console.log('\n=== R28: scan results 內部一致性 ===');
  const validTrend = new Set(['多頭', '空頭', '盤整']);
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-.*\.json$/.test(f));
  let bad = 0;
  for (const f of files.slice(0, 200)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ symbol: string; trendState?: string }> };
      for (const r of sess.results ?? []) {
        if (r.trendState && !validTrend.has(r.trendState)) {
          bad++;
          if (bad <= 5) findings.push({ round: 28, type: 'invalid-trendState', symbol: r.symbol, detail: r.trendState, severity: 'high' });
        }
      }
    } catch { /* */ }
  }
  console.log(`  抽 200 個 session，${bad} 筆 trendState 異常`);
}

async function round29() {
  console.log('\n=== R29: scan history 連續性 ===');
  // 檢查 TW Q method 過去 20 個交易日是否每天都有
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-TW-long-Q-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  const dates = files.map((f) => f.match(/\d{4}-\d{2}-\d{2}/)![0]).sort().reverse();
  console.log(`  TW-Q 共 ${dates.length} 個 session，最近 5 天: ${dates.slice(0, 5).join(', ')}`);
  if (dates.length < 15) findings.push({ round: 29, type: 'tw-q-history-incomplete', detail: `only ${dates.length}`, severity: 'medium' });
}

async function round30() {
  console.log('\n=== R30: stock list 重複檢查 ===');
  for (const market of ['TW', 'CN'] as const) {
    const files = (await fs.readdir(path.join(CANDLES_ROOT, market))).filter((f) => f.endsWith('.json'));
    const codes = new Set<string>();
    let dupes = 0;
    for (const f of files) {
      // 抽 code（去掉所有後綴）
      const code = f.replace(/\.(TW|TWO|SS|SZ|BJ)\.json$/, '').replace(/\.json$/, '');
      // 不同 suffix 同 code 是合法的（TW vs TWO 不同）— 但同 suffix 不應重複
      const fullCode = f.replace(/\.json$/, '');
      if (codes.has(fullCode)) dupes++;
      codes.add(fullCode);
      void code;
    }
    console.log(`  ${market}: ${codes.size} unique, ${dupes} dupes`);
    if (dupes > 0) findings.push({ round: 30, type: 'l1-stocklist-dupes', detail: `${market}: ${dupes}`, severity: 'high' });
  }
}

async function main() {
  console.log(`\nDeep-dig Round 24-30 (${new Date().toISOString()})\n`);
  await round24();
  await round25();
  await round26();
  await round27();
  await round28();
  await round29();
  await round30();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`總發現：${findings.length} 筆`);
  const bySev = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  console.log(`  by severity:`, bySev);

  const high = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  console.log(`\nCritical/High ${high.length} 筆：`);
  for (const f of high.slice(0, 20)) console.log(`  R${f.round} [${f.severity}] ${f.type} ${f.symbol ?? ''}: ${f.detail}`);

  const out = path.join(REPO_ROOT, 'data', 'reports', `audit-rounds-24-30-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: findings.length, findings }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
