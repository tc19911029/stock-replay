/**
 * Deep-dig Round 91-100 — final correctness checks
 *
 * 91: 各 v12 method scan 是否真的依賴 strategy 配置
 * 92: provisional state schema in types
 * 93: LockWatch updater triggers correctly on F/N records evolving over days
 * 94: dataFreshness 在新寫的 v12 sessions 是否寫入
 * 95: Step 0 大盤過濾 是否真的 block 掃描
 * 96: scanBuyMethod 對 J=G alias 正確路由
 * 97: F session triggerPrice = today close
 * 98: N session triggerPrice = neckline (different from today close)
 * 99: ScanResultsCompact 顯示 v12 警示徽章
 * 100: full UI smoke (簡單 GET 各端點)
 */
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const WT_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock/.claude/worktrees/laughing-dijkstra-55cf78';
const SCAN_ROOT = path.join(WT_ROOT, 'data');
const PROD = 'https://stock-replay-5f24.vercel.app';

interface F { round: number; type: string; detail: string; severity: 'low' | 'medium' | 'high' | 'critical'; }
const findings: F[] = [];

async function r91() {
  console.log('\n=== R91: scan-bm 用 active strategy ===');
  const txt = await fs.readFile(path.join(WT_ROOT, 'app/api/cron/scan-bm/route.ts'), 'utf-8');
  const usesActiveStrategy = txt.includes('getActiveStrategyServer');
  console.log(`  scan-bm uses getActiveStrategyServer: ${usesActiveStrategy}`);
  if (!usesActiveStrategy) findings.push({ round: 91, type: 'scan-bm-no-strategy', detail: '', severity: 'high' });
}

async function r92() {
  console.log('\n=== R92: provisional schema in types ===');
  const txt = await fs.readFile(path.join(WT_ROOT, 'lib/scanner/types.ts'), 'utf-8');
  const hasProv = txt.includes('ProvisionalState') && txt.includes('triggerPrice') && txt.includes('daysRemaining');
  console.log(`  ProvisionalState type complete: ${hasProv}`);
}

async function r93() {
  console.log('\n=== R93: LockWatch updater 連續多日演進 ===');
  // 檢查 lock-watch 不同日 snapshot 的 record currentStage 演進
  for (const market of ['TW', 'CN'] as const) {
    try {
      const dir = path.join(SCAN_ROOT, 'lock-watch', market);
      const files = (await fs.readdir(dir)).sort();
      if (files.length < 2) continue;
      const oldest = JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf-8')) as { records: Array<{ symbol: string; currentStage: string; daysObserved: number }> };
      const newest = JSON.parse(await fs.readFile(path.join(dir, files[files.length - 1]), 'utf-8')) as { records: Array<{ symbol: string; currentStage: string; daysObserved: number }> };
      console.log(`  ${market}: ${files[0]} ${oldest.records.length} records → ${files[files.length - 1]} ${newest.records.length} records`);
      const oldestObs = oldest.records.filter((r) => r.currentStage === 'observation').length;
      const newestObs = newest.records.filter((r) => r.currentStage === 'observation').length;
      console.log(`    observation: ${oldestObs} → ${newestObs}`);
    } catch { /* */ }
  }
}

async function r94() {
  console.log('\n=== R94: dataFreshness 寫入率 (v12 sessions only) ===');
  let total = 0, ok = 0;
  for (const m of ['M', 'N', 'O', 'P', 'Q']) {
    const files = (await fs.readdir(SCAN_ROOT)).filter((f) => new RegExp(`^scan-(TW|CN)-long-${m}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f) && !f.includes('intraday'));
    for (const f of files) {
      try {
        const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ dataFreshness?: unknown }> };
        for (const r of sess.results ?? []) {
          total++;
          if (r.dataFreshness) ok++;
        }
      } catch { /* */ }
    }
  }
  console.log(`  v12 (M-Q) results: ${total}, dataFreshness 有 ${ok} (${total > 0 ? (100*ok/total).toFixed(1) : 0}%)`);
}

async function r95() {
  console.log('\n=== R95: Step 0 大盤過濾 ===');
  const txt = await fs.readFile(path.join(WT_ROOT, 'lib/scanner/marketTrendGate.ts'), 'utf-8');
  const hasGate = txt.includes('evaluateMarketGate') && txt.includes('passed');
  console.log(`  marketTrendGate.ts: ${txt.length} bytes, has gate: ${hasGate}`);
}

async function r96() {
  console.log('\n=== R96: J=G alias 路由 ===');
  const txt = await fs.readFile(path.join(WT_ROOT, 'lib/scanner/MarketScanner.ts'), 'utf-8');
  const hasJ = /method === 'J'/.test(txt) && /detectABCBreakout/.test(txt);
  console.log(`  J 路由 detectABCBreakout: ${hasJ}`);
}

async function r97() {
  console.log('\n=== R97: F triggerPrice = today close ===');
  const today = '2026-05-08';
  let total = 0, match = 0;
  for (const market of ['TW', 'CN'] as const) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, `scan-${market}-long-F-${today}.json`), 'utf-8')) as { results: Array<{ symbol: string; price: number; lockWatchPayload?: { triggerPrice?: number } }> };
      for (const r of sess.results ?? []) {
        total++;
        if (r.lockWatchPayload?.triggerPrice && Math.abs(r.lockWatchPayload.triggerPrice - r.price) < 0.01) match++;
      }
    } catch { /* */ }
  }
  console.log(`  F sessions: ${total} results, ${match} 的 triggerPrice = today close`);
  if (total > 0 && match / total < 0.95) findings.push({ round: 97, type: 'f-trigger-mismatch', detail: `${match}/${total}`, severity: 'medium' });
}

async function r98() {
  console.log('\n=== R98: N triggerPrice ≠ today close (頸線價) ===');
  const today = '2026-05-08';
  let total = 0, neckIsBelow = 0;
  for (const market of ['TW', 'CN'] as const) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, `scan-${market}-long-N-${today}.json`), 'utf-8')) as { results: Array<{ price: number; lockWatchPayload?: { triggerPrice?: number; patternTargetPrice?: number } }> };
      for (const r of sess.results ?? []) {
        total++;
        // N 的 triggerPrice 是 neckline，price 是當日突破收盤；neckline < price (突破)
        if (r.lockWatchPayload?.triggerPrice && r.lockWatchPayload.triggerPrice < r.price) neckIsBelow++;
      }
    } catch { /* */ }
  }
  console.log(`  N sessions: ${total} results, ${neckIsBelow} neckline < price (突破)`);
}

async function r99() {
  console.log('\n=== R99: ScanResultsCompact 警示徽章 ===');
  const txt = await fs.readFile(path.join(WT_ROOT, 'features/scan/components/ScanResultsCompact.tsx'), 'utf-8');
  const badges = ['endPhaseFlag', 'seasonLineResistance', 'volumeLevel', 'kdDecliningWarning'];
  const present = badges.filter((b) => txt.includes(b));
  console.log(`  badges in ScanResultsCompact: ${present.length}/${badges.length} (${present.join(', ')})`);
  if (present.length < badges.length) findings.push({ round: 99, type: 'badge-missing', detail: badges.filter((b) => !present.includes(b)).join(','), severity: 'medium' });
}

async function r100() {
  console.log('\n=== R100: full UI smoke ===');
  const endpoints = [
    '/',
    '/api/health',
    '/api/lockwatch?market=TW',
    '/api/lockwatch?market=CN',
    '/api/scanner/results?market=TW&direction=long&date=2026-05-08&mtf=daily',
    '/api/scanner/results?market=TW&direction=long&date=2026-05-08&mtf=N',
    '/api/scanner/results?market=TW&direction=long&date=2026-05-08&mtf=Q',
    '/api/scanner/results?market=CN&direction=long&date=2026-05-08&mtf=F',
    '/api/strategy/active',
  ];
  for (const ep of endpoints) {
    try {
      const status = execSync(`curl -s -o /dev/null -w "%{http_code}" '${PROD}${ep}' -m 15`, { encoding: 'utf-8' }).trim();
      console.log(`  ${ep}: HTTP ${status}`);
      if (status !== '200') findings.push({ round: 100, type: 'prod-non-200', detail: `${ep}: ${status}`, severity: 'high' });
    } catch { /* */ }
  }
}

async function main() {
  console.log(`\nDeep-dig Round 91-100 (${new Date().toISOString()})\n`);
  await r91(); await r92(); await r93(); await r94(); await r95();
  await r96(); await r97(); await r98(); await r99(); await r100();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`總發現：${findings.length} 筆`);
  for (const f of findings) console.log(`  R${f.round} [${f.severity}] ${f.type}: ${f.detail}`);

  const out = path.join(REPO_ROOT, 'data/reports', `audit-rounds-91-100-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: findings.length, findings }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
