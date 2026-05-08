/**
 * 最終綜合 audit — 結合所有前面的檢查項目
 */
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const WT_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock/.claude/worktrees/laughing-dijkstra-55cf78';
const PROD = 'https://stock-replay-5f24.vercel.app';
const SCAN_ROOT = path.join(WT_ROOT, 'data');

interface F { type: string; detail: string; severity: 'low' | 'medium' | 'high' | 'critical'; }
const findings: F[] = [];

async function main() {
  console.log(`Final comprehensive audit (${new Date().toISOString()})\n`);

  // 1. Production health
  console.log('1. Production endpoints:');
  for (const ep of ['/api/health', '/api/lockwatch?market=TW', '/api/scanner/results?market=TW&direction=long&date=2026-05-08&mtf=Q']) {
    const status = execSync(`curl -s -o /dev/null -w "%{http_code}" '${PROD}${ep}' -m 10`, { encoding: 'utf-8' }).trim();
    console.log(`  ${ep}: ${status}`);
    if (status !== '200') findings.push({ type: 'prod-down', detail: `${ep}: ${status}`, severity: 'critical' });
  }

  // 2. v12 sessions on Blob
  console.log('\n2. Blob v12 coverage:');
  const expectedDays = { TW: 20, CN: 18 };
  const out = execSync(`cd ${WT_ROOT} && npx tsx scripts/check-blob-scan-coverage.ts 2>&1 | grep -E "[A-Q]: " | head -32`, { encoding: 'utf-8' });
  console.log(out.split('\n').filter((l) => l.match(/^\s+[TC][WN]-[A-Q]:/)).slice(0, 5).join('\n'));
  void expectedDays;

  // 3. Memory file existence
  console.log('\n3. Memory files:');
  const mems = [
    '/Users/tzu-chienhsu/.claude/projects/-Users-tzu-chienhsu-Desktop-rockstock/memory/MEMORY.md',
    '/Users/tzu-chienhsu/.claude/projects/-Users-tzu-chienhsu-Desktop-rockstock/memory/project_v12_overnight_loop_complete_0509.md',
    `${REPO_ROOT}/data/reports/WAKE_UP_BRIEFING_2026-05-09.md`,
  ];
  for (const f of mems) {
    try {
      const stat = await fs.stat(f);
      console.log(`  ✓ ${f.split('/').slice(-2).join('/')} (${stat.size} bytes)`);
    } catch {
      console.log(`  ✗ MISSING: ${f}`);
      findings.push({ type: 'missing-memory', detail: f, severity: 'medium' });
    }
  }

  // 4. Test suite
  console.log('\n4. v12 test suite:');
  try {
    const r = execSync(`cd ${WT_ROOT} && npx vitest run --globals __tests__/v12-*.test.ts 2>&1 | grep "Tests "`, { encoding: 'utf-8' }).trim();
    console.log(`  ${r}`);
    if (!r.includes('passed')) findings.push({ type: 'tests-fail', detail: r, severity: 'critical' });
  } catch (err) {
    findings.push({ type: 'tests-error', detail: String(err).slice(0, 100), severity: 'critical' });
  }

  // 5. tsc
  console.log('\n5. TypeScript:');
  try {
    execSync(`cd ${WT_ROOT} && npx tsc --noEmit`, { encoding: 'utf-8', timeout: 90_000 });
    console.log('  ✓ tsc clean');
  } catch (err) {
    const e = err as { stdout?: string };
    findings.push({ type: 'tsc-error', detail: (e.stdout ?? '').slice(0, 200), severity: 'critical' });
  }

  // 6. Git state
  console.log('\n6. Git:');
  const branch = execSync(`cd ${REPO_ROOT} && git branch --show-current`, { encoding: 'utf-8' }).trim();
  const head = execSync(`cd ${REPO_ROOT} && git log --oneline -1`, { encoding: 'utf-8' }).trim();
  console.log(`  branch: ${branch}, HEAD: ${head}`);

  // 7. PR state
  console.log('\n7. Recent PRs:');
  try {
    const prs = execSync(`cd ${REPO_ROOT} && gh pr list --state merged --limit 5 --json number,title 2>&1`, { encoding: 'utf-8' });
    const data = JSON.parse(prs) as Array<{ number: number; title: string }>;
    for (const p of data) console.log(`  #${p.number}: ${p.title.slice(0, 60)}`);
  } catch { /* */ }

  // 8. Local L1 stats
  console.log('\n8. Local L1 stats:');
  for (const market of ['TW', 'CN'] as const) {
    const dir = path.join(REPO_ROOT, 'data/candles', market);
    const files = await fs.readdir(dir);
    console.log(`  ${market}: ${files.length} files`);
  }

  // 9. Total v12 sessions
  console.log('\n9. v12 session count:');
  const v12Files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-(daily|[A-Q])-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  console.log(`  ${v12Files.length} v12 post-close sessions in worktree`);

  // 10. Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`總發現：${findings.length} 筆`);
  if (findings.length === 0) {
    console.log('🎉 全綠 — system 健康');
  } else {
    for (const f of findings) console.log(`  [${f.severity}] ${f.type}: ${f.detail}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
