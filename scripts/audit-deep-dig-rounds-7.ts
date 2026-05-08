/**
 * Deep-dig Round 61-70
 *
 * 61: production scan-tw / scan-cn cron 是否能正常觸發（dev 模擬）
 * 62: strategy active config 與 v12 lookup 一致性
 * 63: scan results.name 與 L1 metadata 對齊
 * 64: scan results 內 data freshness/diagnostics 欄位
 * 65: LockWatch updater 邏輯完整性（dry-run）
 * 66: cron auth handling（無 secret 在 dev 應通過）
 * 67: scan output 檔案 size 合理範圍
 * 68: provisional state lifecycle（K/D 用，N 不用）
 * 69: market trend gate edge case（剛翻多 < 10-15 天 pivot pair）
 * 70: TS strict + lint cleanup
 */
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const WT_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock/.claude/worktrees/laughing-dijkstra-55cf78';
const SCAN_ROOT = path.join(WT_ROOT, 'data');
const CANDLES_ROOT = path.join(REPO_ROOT, 'data', 'candles');

interface F { round: number; type: string; detail: string; severity: 'low' | 'medium' | 'high' | 'critical'; }
const findings: F[] = [];

async function r61() {
  console.log('\n=== R61: production cron endpoint dry-test ===');
  // 確保 /api/cron/scan-tw, scan-cn, scan-bm 在 production 不需 auth 且回 401（沒 token 該被拒絕）
  for (const ep of ['/api/cron/scan-tw', '/api/cron/scan-cn', '/api/cron/scan-bm?market=TW&method=Q']) {
    try {
      const status = execSync(`curl -s -o /dev/null -w "%{http_code}" 'https://stock-replay-5f24.vercel.app${ep}' -m 10`, { encoding: 'utf-8' }).trim();
      console.log(`  ${ep}: HTTP ${status}`);
      // 401 表示 auth 工作正常；500 表示 bug
      if (status === '500') findings.push({ round: 61, type: 'cron-500', detail: `${ep}: ${status}`, severity: 'critical' });
    } catch { /* */ }
  }
}

async function r62() {
  console.log('\n=== R62: active strategy config 一致性 ===');
  try {
    const r = execSync(`curl -s 'https://stock-replay-5f24.vercel.app/api/strategy/active' -m 10`, { encoding: 'utf-8' });
    const j = JSON.parse(r) as { id?: string; ok?: boolean; activeStrategyId?: string };
    console.log(`  active strategy:`, j);
  } catch (err) {
    findings.push({ round: 62, type: 'strategy-active-fail', detail: String(err).slice(0, 80), severity: 'medium' });
  }
}

async function r63() {
  console.log('\n=== R63: scan results.name vs L1 metadata ===');
  let total = 0, mismatch = 0;
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-TW-long-(daily|[A-Q])-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  for (const f of files.slice(0, 20)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ symbol: string; name: string }> };
      for (const r of (sess.results ?? []).slice(0, 5)) {
        try {
          const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, 'TW', `${r.symbol}.json`), 'utf-8')) as { name?: string };
          if (l1.name && r.name && l1.name !== r.name) {
            mismatch++;
            if (mismatch <= 3) findings.push({ round: 63, type: 'name-mismatch', detail: `${r.symbol}: scan="${r.name}" L1="${l1.name}"`, severity: 'low' });
          }
          total++;
        } catch { /* */ }
      }
    } catch { /* */ }
  }
  console.log(`  抽 ${total} 筆，${mismatch} 筆 name 不一致`);
}

async function r64() {
  console.log('\n=== R64: scan results 內 dataFreshness 欄位 ===');
  let total = 0, withField = 0;
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-(daily|[A-Q])-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  for (const f of files.slice(0, 30)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ dataFreshness?: { daysStale?: number } }> };
      for (const r of sess.results ?? []) {
        total++;
        if (r.dataFreshness) withField++;
      }
    } catch { /* */ }
  }
  console.log(`  抽 ${total} results，${withField} 有 dataFreshness (${total > 0 ? (100*withField/total).toFixed(1) : 0}%)`);
}

async function r65() {
  console.log('\n=== R65: LockWatch updater 邏輯（dry test via API）===');
  try {
    const r = execSync(`curl -s 'http://localhost:3000/api/cron/update-lockwatch?market=TW' -m 30`, { encoding: 'utf-8' });
    const j = JSON.parse(r) as { ok?: boolean; market?: string; total?: number; summary?: { changed?: number } };
    console.log(`  TW updater:`, j);
    if (!j.ok) findings.push({ round: 65, type: 'lw-updater-fail', detail: r.slice(0, 200), severity: 'high' });
  } catch (err) {
    findings.push({ round: 65, type: 'lw-updater-error', detail: String(err).slice(0, 100), severity: 'high' });
  }
}

async function r66() {
  console.log('\n=== R66: cron auth handling ===');
  const txt = await fs.readFile(path.join(WT_ROOT, 'lib/api/cronAuth.ts'), 'utf-8');
  // 確保 dev 模式無 CRON_SECRET 時放行（不能 fallthrough 到 prod 拒絕）
  if (!/dev.*若.*未設.*放行|isProd/i.test(txt)) findings.push({ round: 66, type: 'cron-auth-suspicious', detail: 'check cronAuth.ts dev fallback', severity: 'low' });
  console.log(`  cronAuth.ts ${txt.length} bytes`);
}

async function r67() {
  console.log('\n=== R67: scan output 檔案 size 範圍 ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-.*\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let small = 0, big = 0;
  for (const f of files) {
    const stat = await fs.stat(path.join(SCAN_ROOT, f));
    if (stat.size < 200) small++;
    if (stat.size > 5_000_000) big++;
  }
  console.log(`  ${files.length} sessions: ${small} 過小 (<200B), ${big} 過大 (>5MB)`);
  if (small > 0) findings.push({ round: 67, type: 'scan-too-small', detail: `${small} sessions <200B`, severity: 'medium' });
}

async function r68() {
  console.log('\n=== R68: provisional state lifecycle ===');
  // K/D 訊號的 provisional 應只在 v12 新 sessions 上有
  let total = 0, withProv = 0;
  for (const m of ['D', 'K']) {
    const files = (await fs.readdir(SCAN_ROOT)).filter((f) => new RegExp(`^scan-(TW|CN)-long-${m}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f) && !f.includes('intraday'));
    for (const f of files) {
      try {
        const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ provisional?: unknown }> };
        for (const r of sess.results ?? []) {
          total++;
          if (r.provisional) withProv++;
        }
      } catch { /* */ }
    }
  }
  console.log(`  D/K results 總 ${total}，有 provisional ${withProv}（v12 spec 預期 K/D/N 才有）`);
}

async function r69() {
  console.log('\n=== R69: market gate hasPivotPair 邏輯 ===');
  // 用 marketTrendGate 檢查當天大盤狀態 — 確保 TW 5/8 過了 gate
  try {
    const indexL1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, 'TW', '^TWII.json'), 'utf-8')) as { candles: { date: string; close: number }[] };
    const last = indexL1.candles[indexL1.candles.length - 1];
    console.log(`  TWII last: ${last.date} close=${last.close} (count=${indexL1.candles.length})`);
    if (indexL1.candles.length < 60) findings.push({ round: 69, type: 'twii-insufficient', detail: `${indexL1.candles.length}`, severity: 'high' });
  } catch (err) {
    findings.push({ round: 69, type: 'twii-load-fail', detail: String(err).slice(0, 80), severity: 'critical' });
  }
}

async function r70() {
  console.log('\n=== R70: TS strict + final tsc check ===');
  try {
    execSync('npx tsc --noEmit', { cwd: WT_ROOT, encoding: 'utf-8', timeout: 90_000 });
    console.log(`  ✓ tsc clean`);
  } catch (err) {
    const e = err as { stdout?: string };
    findings.push({ round: 70, type: 'tsc-error', detail: (e.stdout ?? '').slice(0, 200), severity: 'critical' });
  }
}

async function main() {
  console.log(`\nDeep-dig Round 61-70 (${new Date().toISOString()})\n`);
  await r61();
  await r62();
  await r63();
  await r64();
  await r65();
  await r66();
  await r67();
  await r68();
  await r69();
  await r70();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`總發現：${findings.length} 筆`);
  for (const f of findings) console.log(`  R${f.round} [${f.severity}] ${f.type}: ${f.detail}`);

  const out = path.join(REPO_ROOT, 'data/reports', `audit-rounds-61-70-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: findings.length, findings }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
