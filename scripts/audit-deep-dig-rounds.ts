/**
 * Deep-dig 多輪審查（Round 3-10 合併執行）
 *
 * Round 3: L1 缺 K 棒（active stocks 過去 90 天 missing K 比例）
 * Round 4: L1 vol=0 spike 重新驗證（本次 fix 後應為 0）
 * Round 5: L1 ratio outliers（>30% 跳幅 in active range）
 * Round 6: L4 changePercent vs L1 actual close 不一致
 * Round 7: L4 schema integrity
 * Round 8: v12 detector cross-method overlap
 * Round 9: LockWatch records 資料品質
 * Round 10: market trend Step 0 資料一致性
 */

import { promises as fs } from 'fs';
import path from 'path';
import { isTradingDay } from '../lib/utils/tradingDay';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const CANDLES_ROOT = path.join(REPO_ROOT, 'data', 'candles');
const SCAN_ROOT = path.join(REPO_ROOT, 'data');

interface Finding { round: number; type: string; symbol?: string; date?: string; detail: string; severity: 'low' | 'medium' | 'high' | 'critical'; }
const findings: Finding[] = [];

// ── Round 3: L1 缺 K 棒（活躍股 ≤90 天） ───────────────────────────────────
async function round3() {
  console.log('\n=== Round 3: L1 缺 K 棒（active 90 天）===');
  const today = new Date('2026-05-08');
  const expectedDays: string[] = [];
  for (let i = 0; i < 90; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    if (isTradingDay(iso, 'TW')) expectedDays.push(iso);
  }
  console.log(`  TW 預期 ${expectedDays.length} 個交易日`);

  let count = 0;
  const files = await fs.readdir(path.join(CANDLES_ROOT, 'TW'));
  for (const f of files) {
    try {
      const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, 'TW', f), 'utf-8')) as { candles: { date: string }[] };
      const cs = l1.candles ?? [];
      if (cs.length < 30) continue;  // 跳過過少 candles 的檔
      const lastDate = cs[cs.length - 1]?.date;
      if (!lastDate || lastDate < '2026-05-01') continue;  // 已停牌的不算
      const dates = new Set(cs.map((c) => c.date));
      const missing = expectedDays.filter((d) => !dates.has(d));
      if (missing.length > 5) {
        const sym = f.replace('.json', '');
        findings.push({ round: 3, type: 'missing-bars-90d', symbol: sym, detail: `${missing.length} 個缺日`, severity: missing.length > 20 ? 'high' : 'medium' });
        count++;
      }
    } catch { /* */ }
  }
  console.log(`  違規 ${count} 支股票（缺 >5 天）`);
}

// ── Round 4: vol=0 spike 重新驗證 ────────────────────────────────────────
async function round4() {
  console.log('\n=== Round 4: vol=0 spike 殘留 ===');
  for (const market of ['TW', 'CN'] as const) {
    const files = await fs.readdir(path.join(CANDLES_ROOT, market));
    let bad = 0;
    for (const f of files) {
      try {
        const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, market, f), 'utf-8')) as { candles: { date: string; close: number; volume?: number }[] };
        const cs = l1.candles ?? [];
        for (let i = 1; i < cs.length; i++) {
          const cur = cs[i], prev = cs[i - 1];
          if ((cur.volume ?? 0) === 0 && prev.close > 0 && Math.abs(cur.close / prev.close - 1) >= 0.30) {
            bad++;
            findings.push({ round: 4, type: 'vol0-spike-residue', symbol: f.replace('.json', ''), date: cur.date, detail: `${prev.close}→${cur.close}`, severity: 'high' });
          }
        }
      } catch { /* */ }
    }
    console.log(`  ${market}: ${bad} 筆殘留`);
  }
}

// ── Round 5: 1 日 ratio outlier (>30% 跳幅 + gap=1) ─────────────────────
async function round5() {
  console.log('\n=== Round 5: 連續日 close ratio >30% jump ===');
  for (const market of ['TW', 'CN'] as const) {
    const files = await fs.readdir(path.join(CANDLES_ROOT, market));
    let bad = 0;
    for (const f of files) {
      try {
        const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, market, f), 'utf-8')) as { candles: { date: string; close: number }[] };
        const cs = (l1.candles ?? []).slice(-90);  // 最近 90 天
        for (let i = 1; i < cs.length; i++) {
          const cur = cs[i], prev = cs[i - 1];
          if (prev.close > 0) {
            const ratio = Math.abs(cur.close / prev.close - 1);
            const dGap = (new Date(cur.date).getTime() - new Date(prev.date).getTime()) / 86400000;
            if (dGap === 1 && ratio > 0.30) {
              bad++;
              if (bad <= 5) findings.push({ round: 5, type: 'ratio-outlier-1d', symbol: f.replace('.json', ''), date: cur.date, detail: `${prev.close}→${cur.close} ratio=${(ratio * 100).toFixed(1)}%`, severity: 'medium' });
            }
          }
        }
      } catch { /* */ }
    }
    console.log(`  ${market}: ${bad} 筆連日跳幅 >30%`);
  }
}

// ── Round 6: L4 changePercent vs L1 actual close ──────────────────────
async function round6() {
  console.log('\n=== Round 6: L4 changePercent vs L1 actual close 不一致 ===');
  const scanFiles = await fs.readdir(SCAN_ROOT);
  const targets = scanFiles.filter((f) => /^scan-(TW|CN)-long.*\.json$/.test(f));
  let mismatch = 0;
  let checked = 0;
  for (const f of targets.slice(0, 50)) {  // 抽 50 檔
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { market: 'TW' | 'CN'; date: string; results: Array<{ symbol: string; price: number; changePercent: number }> };
      for (const r of (sess.results ?? []).slice(0, 5)) {
        const sym = r.symbol;
        const candPath = path.join(CANDLES_ROOT, sess.market, `${sym}.json`);
        try {
          const l1 = JSON.parse(await fs.readFile(candPath, 'utf-8')) as { candles: { date: string; close: number }[] };
          const cs = l1.candles ?? [];
          const idx = cs.findIndex((c) => c.date === sess.date);
          if (idx > 0) {
            const actualChange = +(((cs[idx].close - cs[idx - 1].close) / cs[idx - 1].close) * 100).toFixed(2);
            if (Math.abs(actualChange - r.changePercent) > 0.5) {
              mismatch++;
              if (mismatch <= 5) findings.push({ round: 6, type: 'l4-changepct-stale', symbol: sym, date: sess.date, detail: `L4=${r.changePercent}% L1=${actualChange}%`, severity: 'high' });
            }
            checked++;
          }
        } catch { /* */ }
      }
    } catch { /* */ }
  }
  console.log(`  抽查 ${checked} 筆，${mismatch} 筆 changePercent 偏差 >0.5%`);
}

// ── Round 7: L4 schema integrity ─────────────────────────────────────────
async function round7() {
  console.log('\n=== Round 7: L4 schema integrity ===');
  const scanFiles = await fs.readdir(SCAN_ROOT);
  const targets = scanFiles.filter((f) => /^scan-.*\.json$/.test(f));
  let bad = 0;
  for (const f of targets) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { id?: string; market?: string; date?: string; sessionType?: string; direction?: string; results?: unknown[]; buyMethod?: string };
      const issues: string[] = [];
      if (!sess.id) issues.push('no-id');
      if (!sess.market) issues.push('no-market');
      if (!sess.date) issues.push('no-date');
      if (!sess.sessionType) issues.push('no-sessionType');
      if (!sess.direction) issues.push('no-direction');
      if (!Array.isArray(sess.results)) issues.push('no-results-array');
      if (issues.length > 0) {
        bad++;
        findings.push({ round: 7, type: 'l4-schema-issue', detail: `${f}: ${issues.join(', ')}`, severity: 'high' });
      }
    } catch (err) {
      bad++;
      findings.push({ round: 7, type: 'l4-parse-fail', detail: `${f}: ${String(err).slice(0, 80)}`, severity: 'critical' });
    }
  }
  console.log(`  ${targets.length} 個 scan 檔，${bad} 筆 schema 異常`);
}

// ── Round 8: v12 detector cross-method overlap ─────────────────────────
async function round8() {
  console.log('\n=== Round 8: v12 detector cross-method overlap ===');
  const today = '2026-05-08';
  const matches: Record<'TW' | 'CN', Record<string, string[]>> = { TW: {}, CN: {} };
  for (const market of ['TW', 'CN'] as const) {
    for (const m of ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q']) {
      try {
        const f = path.join(SCAN_ROOT, `scan-${market}-long-${m}-${today}.json`);
        const sess = JSON.parse(await fs.readFile(f, 'utf-8')) as { results: { symbol: string }[] };
        for (const r of sess.results ?? []) {
          if (!matches[market][r.symbol]) matches[market][r.symbol] = [];
          matches[market][r.symbol].push(m);
        }
      } catch { /* */ }
    }
  }
  for (const market of ['TW', 'CN'] as const) {
    const overlapping = Object.entries(matches[market]).filter(([, ms]) => ms.length >= 4);
    console.log(`  ${market}: ${Object.keys(matches[market]).length} 支命中至少 1 個 method，${overlapping.length} 支命中 ≥4 個`);
    for (const [sym, ms] of overlapping.slice(0, 5)) {
      findings.push({ round: 8, type: 'cross-method-heavy-overlap', symbol: sym, detail: `${market} hits ${ms.length}: ${ms.join(',')}`, severity: 'low' });
    }
  }
}

// ── Round 9: LockWatch 資料品質 ───────────────────────────────────────
async function round9() {
  console.log('\n=== Round 9: LockWatch 資料品質 ===');
  const lwRoot = path.join(SCAN_ROOT, 'lock-watch');
  let total = 0, bad = 0;
  try {
    for (const market of ['TW', 'CN'] as const) {
      const dir = path.join(lwRoot, market);
      try {
        const files = await fs.readdir(dir);
        for (const f of files) {
          const snap = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8')) as { records: Array<{ symbol: string; triggerPrice: number; currentStage: string; triggerSignal: 'F' | 'N'; patternType?: string; patternTargetPrice?: number }> };
          for (const r of snap.records ?? []) {
            total++;
            if (r.triggerPrice <= 0) { bad++; findings.push({ round: 9, type: 'lockwatch-bad-trigger-price', symbol: r.symbol, detail: `trigger=${r.triggerPrice}`, severity: 'high' }); }
            if (r.triggerSignal === 'N' && (!r.patternType || !r.patternTargetPrice)) { bad++; findings.push({ round: 9, type: 'lockwatch-N-incomplete', symbol: r.symbol, detail: `pattern=${r.patternType ?? 'none'} target=${r.patternTargetPrice ?? 'none'}`, severity: 'medium' }); }
          }
        }
      } catch { /* */ }
    }
  } catch { /* */ }
  console.log(`  ${total} 筆 LockWatch records，${bad} 筆異常`);
}

// ── Round 10: market trend Step 0 一致性 ────────────────────────────
async function round10() {
  console.log('\n=== Round 10: market trend Step 0 一致性 ===');
  const scanFiles = await fs.readdir(SCAN_ROOT);
  const today = '2026-05-08';
  const trends: Record<'TW' | 'CN', string[]> = { TW: [], CN: [] };
  for (const f of scanFiles) {
    if (!f.includes(today)) continue;
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { market: 'TW' | 'CN'; marketTrend?: string };
      if (sess.marketTrend) trends[sess.market].push(sess.marketTrend);
    } catch { /* */ }
  }
  for (const market of ['TW', 'CN'] as const) {
    const unique = [...new Set(trends[market])];
    console.log(`  ${market} ${today}: ${unique.length} 種 trend = ${unique.join(', ')} (samples=${trends[market].length})`);
    if (unique.length > 1) findings.push({ round: 10, type: 'market-trend-inconsistent', detail: `${market} ${today} got ${unique.join(', ')}`, severity: 'critical' });
  }
}

async function main() {
  console.log(`\nDeep-dig rounds 3-10 (${new Date().toISOString()})\n`);
  await round3();
  await round4();
  await round5();
  await round6();
  await round7();
  await round8();
  await round9();
  await round10();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`總發現：${findings.length} 筆`);
  const bySeverity = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  console.log(`  by severity:`, bySeverity);

  const byRound = findings.reduce((acc, f) => { acc[f.round] = (acc[f.round] ?? 0) + 1; return acc; }, {} as Record<number, number>);
  console.log(`  by round:`, byRound);

  // 列出 critical/high
  const high = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  console.log(`\nCritical/High 共 ${high.length} 筆：`);
  for (const f of high.slice(0, 30)) {
    console.log(`  R${f.round} [${f.severity}] ${f.type} ${f.symbol ?? ''} ${f.date ?? ''}: ${f.detail}`);
  }

  const out = path.join(REPO_ROOT, 'data', 'reports', `audit-rounds-3-10-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: findings.length, findings }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
