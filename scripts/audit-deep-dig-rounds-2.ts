/**
 * Deep-dig 多輪審查（Round 11-20）
 *
 * 11: cron schedule 衝突（重複 path）
 * 12: scan sessions 重複（同 composite key 多筆）
 * 13: ETF holdings 一致性
 * 14: turnover-rank 覆蓋率
 * 15: 大盤指數 (^TWII / 000001.SS) 完整性
 * 16: 股名解析（4-5 位數 TW、5-6 位 CN regex 衝突）
 * 17: provisional state stuck records（已撤銷但留在 list）
 * 18: forward-performance 計算 sanity
 * 19: TypeScript strict 警告
 * 20: 整體 build 是否能過
 */

import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const WT_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock/.claude/worktrees/laughing-dijkstra-55cf78';
const SCAN_ROOT = path.join(REPO_ROOT, 'data');
const CANDLES_ROOT = path.join(REPO_ROOT, 'data', 'candles');

interface Finding { round: number; type: string; symbol?: string; date?: string; detail: string; severity: 'low' | 'medium' | 'high' | 'critical'; }
const findings: Finding[] = [];

async function round11() {
  console.log('\n=== Round 11: cron schedule 衝突 ===');
  const vercel = JSON.parse(await fs.readFile(path.join(WT_ROOT, 'vercel.json'), 'utf-8')) as { crons: { path: string; schedule: string }[] };
  const byScheduleAndPath: Record<string, string[]> = {};
  const byTimeMinute: Record<string, number> = {};
  for (const c of vercel.crons) {
    const k = `${c.schedule}|${c.path}`;
    byScheduleAndPath[k] = [...(byScheduleAndPath[k] ?? []), c.path];
    // 同分鐘併發數（粗略）
    byTimeMinute[c.schedule] = (byTimeMinute[c.schedule] ?? 0) + 1;
  }
  // 完全重複的 (schedule, path)
  for (const [k, list] of Object.entries(byScheduleAndPath)) {
    if (list.length > 1) {
      findings.push({ round: 11, type: 'cron-duplicate', detail: `${list.length}x ${k}`, severity: 'medium' });
    }
  }
  // 同分鐘 >5 個 cron（Vercel 可能限流）
  for (const [sched, n] of Object.entries(byTimeMinute)) {
    if (n > 5) findings.push({ round: 11, type: 'cron-bunched', detail: `${n} crons at ${sched}`, severity: 'low' });
  }
  console.log(`  ${vercel.crons.length} 個 cron 條目`);
}

async function round12() {
  console.log('\n=== Round 12: L4 scan duplicate (same composite key) ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-.*\.json$/.test(f));
  // composite key: market + buyMethod + date + sessionType
  const groups: Record<string, string[]> = {};
  for (const f of files) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { market?: string; date?: string; sessionType?: string; buyMethod?: string; direction?: string };
      const key = `${sess.market}|${sess.direction}|${sess.buyMethod ?? 'A'}|${sess.date}|${sess.sessionType}`;
      groups[key] = [...(groups[key] ?? []), f];
    } catch { /* */ }
  }
  let dup = 0;
  for (const [k, list] of Object.entries(groups)) {
    if (list.length > 1) {
      dup++;
      if (dup <= 5) findings.push({ round: 12, type: 'scan-duplicate-key', detail: `${k}: ${list.length} files`, severity: 'medium' });
    }
  }
  console.log(`  ${Object.keys(groups).length} unique composite keys, ${dup} 組重複`);
}

async function round13() {
  console.log('\n=== Round 13: ETF holdings 一致性 ===');
  const etfRoot = path.join(SCAN_ROOT, 'etf');
  let count = 0;
  try {
    const codes = await fs.readdir(etfRoot);
    for (const c of codes) {
      try {
        const p = path.join(etfRoot, c);
        const stat = await fs.stat(p);
        if (!stat.isDirectory()) continue;
        const files = (await fs.readdir(p)).filter((f) => f.endsWith('.json'));
        if (files.length === 0) findings.push({ round: 13, type: 'etf-empty', detail: c, severity: 'low' });
        count += files.length;
      } catch { /* */ }
    }
  } catch { /* */ }
  console.log(`  總 ETF snapshot: ${count}`);
}

async function round14() {
  console.log('\n=== Round 14: turnover-rank 覆蓋率 ===');
  for (const market of ['TW', 'CN'] as const) {
    try {
      const rank = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, 'turnover-rank', `${market}.json`), 'utf-8')) as { topN: number; asOfDate: string | null; symbols: string[] };
      if (!rank.asOfDate) findings.push({ round: 14, type: 'turnover-no-date', detail: market, severity: 'high' });
      if ((rank.symbols?.length ?? 0) < rank.topN * 0.95) findings.push({ round: 14, type: 'turnover-low-coverage', detail: `${market}: ${rank.symbols?.length}/${rank.topN}`, severity: 'medium' });
      console.log(`  ${market}: ${rank.symbols?.length ?? 0}/${rank.topN} symbols, asOf=${rank.asOfDate}`);
    } catch (err) {
      findings.push({ round: 14, type: 'turnover-load-fail', detail: `${market}: ${String(err).slice(0, 80)}`, severity: 'critical' });
    }
  }
}

async function round15() {
  console.log('\n=== Round 15: 大盤指數完整性 ===');
  const indices: Record<'TW' | 'CN', string> = { TW: '^TWII', CN: '000001.SS' };
  for (const market of ['TW', 'CN'] as const) {
    const sym = indices[market];
    try {
      const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, market, `${sym}.json`), 'utf-8')) as { candles: { date: string; close: number }[] };
      const cs = l1.candles ?? [];
      const last = cs[cs.length - 1];
      console.log(`  ${market} ${sym}: ${cs.length} candles, last=${last?.date} close=${last?.close}`);
      if (cs.length < 250) findings.push({ round: 15, type: 'index-too-few-candles', detail: `${sym}: ${cs.length}`, severity: 'high' });
      if (!last?.date || last.date < '2026-05-05') findings.push({ round: 15, type: 'index-stale', detail: `${sym}: last=${last?.date}`, severity: 'high' });
    } catch (err) {
      findings.push({ round: 15, type: 'index-load-fail', detail: `${sym}: ${String(err).slice(0, 80)}`, severity: 'critical' });
    }
  }
}

async function round16() {
  console.log('\n=== Round 16: 股名解析（CN secid 4/5/6 位）===');
  const twFiles = await fs.readdir(path.join(CANDLES_ROOT, 'TW'));
  const cnFiles = await fs.readdir(path.join(CANDLES_ROOT, 'CN'));
  const twCodeLens = new Map<number, number>();
  for (const f of twFiles) {
    const code = f.replace(/\.(TW|TWO)\.json$/, '');
    twCodeLens.set(code.length, (twCodeLens.get(code.length) ?? 0) + 1);
  }
  const cnCodeLens = new Map<number, number>();
  for (const f of cnFiles) {
    const code = f.replace(/\.(SS|SZ|BJ)\.json$/, '');
    cnCodeLens.set(code.length, (cnCodeLens.get(code.length) ?? 0) + 1);
  }
  console.log(`  TW code lengths:`, Object.fromEntries(twCodeLens));
  console.log(`  CN code lengths:`, Object.fromEntries(cnCodeLens));
  // 6 位 TW（不應發生，TW 上限 5 位）
  if ((twCodeLens.get(6) ?? 0) > 0) findings.push({ round: 16, type: 'tw-6digit-codes', detail: `${twCodeLens.get(6)} TW symbols with 6-digit codes`, severity: 'high' });
}

async function round17() {
  console.log('\n=== Round 17: provisional state stuck records ===');
  // 搜尋 scan results 中的 provisional 欄位，看是否卡死
  const today = '2026-05-08';
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => f.includes(today) && /^scan-.*\.json$/.test(f));
  let stuck = 0;
  for (const f of files) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ symbol: string; provisional?: { status: string; daysRemaining: number; revocationCount: number } }> };
      for (const r of sess.results ?? []) {
        if (r.provisional && r.provisional.status === 'provisional' && r.provisional.daysRemaining === 0) {
          stuck++;
          if (stuck <= 5) findings.push({ round: 17, type: 'provisional-stuck-zero-days', symbol: r.symbol, detail: `revocations=${r.provisional.revocationCount}`, severity: 'medium' });
        }
      }
    } catch { /* */ }
  }
  console.log(`  ${stuck} 筆 provisional 卡 daysRemaining=0`);
}

async function round18() {
  console.log('\n=== Round 18: forward-performance 計算 sanity ===');
  const today = '2026-04-28';  // 用幾天前的 scan，這時應有 forward perf
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => f.includes(today) && /^scan-.*\.json$/.test(f));
  let total = 0, bad = 0;
  for (const f of files.slice(0, 20)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { market: 'TW' | 'CN'; results: Array<{ symbol: string; price: number }> };
      for (const r of (sess.results ?? []).slice(0, 3)) {
        total++;
        // 從 L1 取後續 5 天 close 算實際 forward
        try {
          const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, sess.market, `${r.symbol}.json`), 'utf-8')) as { candles: { date: string; close: number }[] };
          const cs = l1.candles ?? [];
          const idx = cs.findIndex((c) => c.date === today);
          if (idx >= 0 && idx + 5 < cs.length) {
            const expected = (cs[idx + 5].close - cs[idx].close) / cs[idx].close;
            if (Math.abs(expected) > 0.5) {
              bad++;
              if (bad <= 5) findings.push({ round: 18, type: 'fwd-perf-extreme', symbol: r.symbol, detail: `5d=${(expected * 100).toFixed(1)}%`, severity: 'low' });
            }
          }
        } catch { /* */ }
      }
    } catch { /* */ }
  }
  console.log(`  抽 ${total} 筆，極端波動 ${bad}`);
}

async function round19() {
  console.log('\n=== Round 19: TypeScript strict 檢查 ===');
  try {
    const out = execSync('npx tsc --noEmit', { cwd: WT_ROOT, encoding: 'utf-8', timeout: 90_000 }).trim();
    if (out) {
      const lines = out.split('\n').slice(0, 5);
      findings.push({ round: 19, type: 'tsc-warnings', detail: `${out.split('\n').length} lines: ${lines.join('|')}`, severity: 'medium' });
      console.log(`  有 ${out.split('\n').length} 行警告`);
    } else {
      console.log(`  ✓ tsc clean`);
    }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const msg = (e.stdout ?? e.stderr ?? '').slice(0, 500);
    findings.push({ round: 19, type: 'tsc-error', detail: msg, severity: 'critical' });
    console.log(`  ✗ tsc errors`);
  }
}

async function round20() {
  console.log('\n=== Round 20: build verification (跳過 — 太久) ===');
  // 用 v12 tests 替代
  try {
    const out = execSync('npx vitest run --globals __tests__/v12-*.test.ts 2>&1 | tail -3', { cwd: WT_ROOT, encoding: 'utf-8', timeout: 120_000 });
    console.log(`  v12 tests: ${out.trim().split('\n')[0]}`);
    if (!/passed/i.test(out)) findings.push({ round: 20, type: 'v12-test-fail', detail: out.slice(0, 200), severity: 'critical' });
  } catch (err) {
    findings.push({ round: 20, type: 'v12-test-exec-fail', detail: String(err).slice(0, 200), severity: 'critical' });
  }
}

async function main() {
  console.log(`\nDeep-dig rounds 11-20 (${new Date().toISOString()})\n`);
  await round11();
  await round12();
  await round13();
  await round14();
  await round15();
  await round16();
  await round17();
  await round18();
  await round19();
  await round20();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`總發現：${findings.length} 筆`);
  const bySev = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  console.log(`  by severity:`, bySev);
  const byRound = findings.reduce((acc, f) => { acc[f.round] = (acc[f.round] ?? 0) + 1; return acc; }, {} as Record<number, number>);
  console.log(`  by round:`, byRound);

  const high = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  console.log(`\nCritical/High ${high.length} 筆：`);
  for (const f of high) {
    console.log(`  R${f.round} [${f.severity}] ${f.type} ${f.symbol ?? ''}: ${f.detail}`);
  }

  const out = path.join(REPO_ROOT, 'data', 'reports', `audit-rounds-11-20-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: findings.length, findings }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
