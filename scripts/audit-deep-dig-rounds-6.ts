/**
 * Deep-dig Round 51-60 — 邊界與一致性
 *
 * 51: scan results 重複 symbol（同 session 內不應有同一 symbol 出現兩次）
 * 52: scan results 內 trendState 與 trendPosition 一致性
 * 53: 各 buy method 的 triggeredRules 是否非空
 * 54: F/N session 是否與當日 LockWatch snapshot 內容一致
 * 55: 連續 cron 後同個 method 結果 stability（同個 K 線兩次跑應同樣）
 * 56: matchedMethods 內邏輯（method=B 應在 matchedMethods 中）
 * 57: TW vs CN 各 buy-method scan 大致 result count 對齊（不應出現 TW 100 / CN 0）
 * 58: detectTrendWithHistory lastTrendChangeDate 寫入率
 * 59: stock.industry 缺漏率
 * 60: scan session id 唯一性
 */
import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const WT_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock/.claude/worktrees/laughing-dijkstra-55cf78';
const SCAN_ROOT = path.join(WT_ROOT, 'data');

interface F { round: number; type: string; symbol?: string; date?: string; detail: string; severity: 'low' | 'medium' | 'high' | 'critical'; }
const findings: F[] = [];

async function r51() {
  console.log('\n=== R51: scan results 重複 symbol ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-.*\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let bad = 0;
  for (const f of files.slice(0, 200)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ symbol: string }> };
      const seen = new Set<string>();
      for (const r of sess.results ?? []) {
        if (seen.has(r.symbol)) {
          bad++;
          if (bad <= 3) findings.push({ round: 51, type: 'duplicate-symbol-in-session', detail: `${f}: ${r.symbol}`, severity: 'high' });
          break;
        }
        seen.add(r.symbol);
      }
    } catch { /* */ }
  }
  console.log(`  抽 200 sessions，${bad} 筆有重複 symbol`);
}

async function r52() {
  console.log('\n=== R52: trendState vs trendPosition 一致性 ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-.*\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let bad = 0;
  for (const f of files.slice(0, 100)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ symbol: string; trendState?: string; trendPosition?: string }> };
      for (const r of sess.results ?? []) {
        if (r.trendState === '空頭' && r.trendPosition && /多頭/.test(r.trendPosition)) {
          bad++;
          if (bad <= 3) findings.push({ round: 52, type: 'trendstate-position-mismatch', symbol: r.symbol, detail: `state=${r.trendState} position=${r.trendPosition}`, severity: 'medium' });
        }
        if (r.trendState === '多頭' && r.trendPosition && /空頭/.test(r.trendPosition)) {
          bad++;
          if (bad <= 3) findings.push({ round: 52, type: 'trendstate-position-mismatch', symbol: r.symbol, detail: `state=${r.trendState} position=${r.trendPosition}`, severity: 'medium' });
        }
      }
    } catch { /* */ }
  }
  console.log(`  抽 100 sessions，${bad} 筆 trendState/Position 矛盾`);
}

async function r53() {
  console.log('\n=== R53: triggeredRules 非空率 ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-[A-Q]-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  let total = 0, empty = 0;
  for (const f of files) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ triggeredRules?: unknown[] }> };
      for (const r of sess.results ?? []) {
        total++;
        if (!r.triggeredRules || r.triggeredRules.length === 0) empty++;
      }
    } catch { /* */ }
  }
  console.log(`  buy-method results 總 ${total}，empty triggeredRules ${empty} (${total > 0 ? (100*empty/total).toFixed(1) : 0}%)`);
  if (total > 0 && empty / total > 0.05) findings.push({ round: 53, type: 'empty-triggeredRules-high', detail: `${empty}/${total}`, severity: 'medium' });
}

async function r54() {
  console.log('\n=== R54: F/N session vs LockWatch snapshot 一致性 ===');
  const date = '2026-05-08';
  for (const market of ['TW', 'CN'] as const) {
    try {
      const fSess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, `scan-${market}-long-F-${date}.json`), 'utf-8')) as { results: Array<{ symbol: string }> };
      const nSess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, `scan-${market}-long-N-${date}.json`), 'utf-8')) as { results: Array<{ symbol: string }> };
      const lwSnap = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, `lock-watch/${market}/${date}.json`), 'utf-8')) as { records: Array<{ symbol: string; triggerSignal: string }> };
      const fSyms = new Set(fSess.results.map((r) => r.symbol));
      const nSyms = new Set(nSess.results.map((r) => r.symbol));
      const lwFSyms = new Set(lwSnap.records.filter((r) => r.triggerSignal === 'F').map((r) => r.symbol));
      const lwNSyms = new Set(lwSnap.records.filter((r) => r.triggerSignal === 'N').map((r) => r.symbol));
      const fOnlyInScan = [...fSyms].filter((s) => !lwFSyms.has(s)).length;
      const fOnlyInLW = [...lwFSyms].filter((s) => !fSyms.has(s)).length;
      console.log(`  ${market} ${date}: scan-F ${fSyms.size}, LW-F ${lwFSyms.size} (only-scan ${fOnlyInScan}, only-LW ${fOnlyInLW})`);
      console.log(`           scan-N ${nSyms.size}, LW-N ${lwNSyms.size}`);
      if (fOnlyInScan > 0) findings.push({ round: 54, type: 'f-scan-not-in-lw', detail: `${market}: ${fOnlyInScan} symbols`, severity: 'medium' });
    } catch { /* */ }
  }
}

async function r55() {
  // 跳過 — 需要實際跑兩次 cron 比較
  console.log('\n=== R55: stability test (skipped — 需執行兩次 scan) ===');
}

async function r56() {
  console.log('\n=== R56: matchedMethods 包含 self ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-[A-Q]-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  let bad = 0;
  for (const f of files.slice(0, 50)) {
    try {
      const m = f.match(/long-([A-Q])-/)![1];
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ symbol: string; matchedMethods?: string[] }> };
      for (const r of sess.results ?? []) {
        if (r.matchedMethods && !r.matchedMethods.includes(m)) {
          bad++;
          if (bad <= 3) findings.push({ round: 56, type: 'matched-missing-self', symbol: r.symbol, detail: `method=${m}, matched=${r.matchedMethods.join(',')}`, severity: 'medium' });
        }
      }
    } catch { /* */ }
  }
  console.log(`  抽 50 sessions，${bad} 筆 matchedMethods 不含 self`);
}

async function r57() {
  console.log('\n=== R57: TW/CN result count 對齊（極端對比）===');
  const date = '2026-05-08';
  const ratios: Array<{ method: string; tw: number; cn: number }> = [];
  for (const m of ['B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q']) {
    try {
      const tw = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, `scan-TW-long-${m}-${date}.json`), 'utf-8')) as { resultCount: number };
      const cn = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, `scan-CN-long-${m}-${date}.json`), 'utf-8')) as { resultCount: number };
      ratios.push({ method: m, tw: tw.resultCount, cn: cn.resultCount });
    } catch { /* */ }
  }
  for (const { method, tw, cn } of ratios) {
    const ratio = (tw + 1) / (cn + 1);
    if (ratio > 10 || ratio < 0.1) findings.push({ round: 57, type: 'tw-cn-extreme-ratio', detail: `${method}: TW=${tw} CN=${cn}`, severity: 'low' });
  }
  console.log(`  TW vs CN: ${ratios.map((x) => `${x.method}=${x.tw}/${x.cn}`).join(' ')}`);
}

async function r58() {
  console.log('\n=== R58: lastTrendChangeDate 寫入率 ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-(daily|[A-Q])-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let total = 0, withField = 0;
  for (const f of files.slice(0, 50)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ lastTrendChangeDate?: string }> };
      for (const r of sess.results ?? []) {
        total++;
        if (r.lastTrendChangeDate) withField++;
      }
    } catch { /* */ }
  }
  console.log(`  抽 50 sessions，${total} results, ${withField} 有 lastTrendChangeDate (${total > 0 ? (100*withField/total).toFixed(1) : 0}%)`);
}

async function r59() {
  console.log('\n=== R59: stock.industry 缺漏率 ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-TW-long-[A-Q]-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  let total = 0, missing = 0;
  for (const f of files.slice(0, 50)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ symbol: string; industry?: string }> };
      for (const r of sess.results ?? []) {
        total++;
        if (!r.industry || r.industry.trim() === '') missing++;
      }
    } catch { /* */ }
  }
  console.log(`  TW sessions ${total} results, ${missing} 缺 industry (${total > 0 ? (100*missing/total).toFixed(1) : 0}%)`);
  if (total > 0 && missing / total > 0.10) findings.push({ round: 59, type: 'industry-missing-high', detail: `${missing}/${total}`, severity: 'low' });
}

async function r60() {
  console.log('\n=== R60: session id 唯一性 ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-.*\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const ids = new Map<string, number>();
  let total = 0;
  for (const f of files) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { id?: string };
      if (sess.id) {
        ids.set(sess.id, (ids.get(sess.id) ?? 0) + 1);
        total++;
      }
    } catch { /* */ }
  }
  const dups = [...ids.entries()].filter(([, n]) => n > 1);
  console.log(`  ${total} sessions, ${ids.size} unique ids, ${dups.length} 重複`);
  if (dups.length > 0) findings.push({ round: 60, type: 'session-id-dupe', detail: `${dups.length}: ${dups.slice(0, 3).map((x) => x[0]).join(',')}`, severity: 'medium' });
}

async function main() {
  console.log(`\nDeep-dig Round 51-60 (${new Date().toISOString()})\n`);
  await r51();
  await r52();
  await r53();
  await r54();
  await r55();
  await r56();
  await r57();
  await r58();
  await r59();
  await r60();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`總發現：${findings.length} 筆`);
  const bySev = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  console.log(`  by severity:`, bySev);
  for (const f of findings.slice(0, 20)) console.log(`  R${f.round} [${f.severity}] ${f.type}: ${f.detail}`);

  const out = path.join(REPO_ROOT, 'data/reports', `audit-rounds-51-60-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: findings.length, findings }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
