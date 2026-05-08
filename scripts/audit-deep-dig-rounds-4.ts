/**
 * Deep-dig Round 31-40
 *
 * 31: scan-bm route VALID_METHODS 一致性
 * 32: ScanPanelVertical 方法 tab 完整性 (UI source)
 * 33: storage Blob 路徑命名一致性
 * 34: vercel.json cron 是否所有方法都有
 * 35: 各 method 是否有 daily updater (LockWatch only)
 * 36: 大盤指數 candles 完整性（TWII/000001.SS 不超過 2 天 stale）
 * 37: ETF holdings 是否有 v12 strategy 標記
 * 38: 主動式 ETF 5-digit code 處理（00400A 等）
 * 39: 7716/7821 等 missing-bar 股票最新狀態
 * 40: 全部 v12 端點 health check
 */
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const WT_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock/.claude/worktrees/laughing-dijkstra-55cf78';

interface F { round: number; type: string; symbol?: string; date?: string; detail: string; severity: 'low' | 'medium' | 'high' | 'critical'; }
const findings: F[] = [];

async function r31() {
  console.log('\n=== R31: scan-bm route 字母一致性 ===');
  const txt = await fs.readFile(path.join(WT_ROOT, 'app/api/cron/scan-bm/route.ts'), 'utf-8');
  const expected = ['B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q'];
  const missing = expected.filter((m) => !txt.includes(`'${m}'`));
  if (missing.length > 0) findings.push({ round: 31, type: 'scan-bm-missing-method', detail: missing.join(','), severity: 'critical' });
  console.log(`  scan-bm: ${expected.length - missing.length}/${expected.length}`);
}

async function r32() {
  console.log('\n=== R32: ScanPanelVertical 方法 tab ===');
  const txt = await fs.readFile(path.join(WT_ROOT, 'features/scan/ScanPanelVertical.tsx'), 'utf-8');
  const expected = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q'];
  const tabs = expected.filter((m) => new RegExp(`['\"]${m}['\"]`).test(txt));
  console.log(`  ScanPanelVertical: ${tabs.length}/${expected.length} 個字母被引用`);
  const missing = expected.filter((m) => !tabs.includes(m));
  if (missing.length > 0) findings.push({ round: 32, type: 'panel-missing-tabs', detail: missing.join(','), severity: 'high' });
}

async function r33() {
  console.log('\n=== R33: scanStorage Blob 路徑命名 ===');
  // Check that listScanDates path generation handles all 16 letters
  const txt = await fs.readFile(path.join(WT_ROOT, 'lib/storage/scanStorage.ts'), 'utf-8');
  const hasJQ = ['J','K','L','M','N','O','P','Q'].some((m) => txt.includes(`'${m}'`));
  if (!hasJQ) {
    // 不一定是 bug — storage 不需要硬編列舉，buyMethod 是字串
    console.log(`  storage 無硬編 J-Q（OK，因為用 string 動態組路徑）`);
  } else {
    console.log(`  storage 有提到 J-Q`);
  }
}

async function r34() {
  console.log('\n=== R34: vercel.json cron 各方法覆蓋 ===');
  const vercel = JSON.parse(await fs.readFile(path.join(WT_ROOT, 'vercel.json'), 'utf-8')) as { crons: { path: string }[] };
  const expected = ['B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q'];
  const tw: string[] = [];
  const cn: string[] = [];
  for (const c of vercel.crons) {
    const tm = c.path.match(/scan-bm\?market=TW&method=([A-Q])/);
    if (tm) tw.push(tm[1]);
    const cm = c.path.match(/scan-bm\?market=CN&method=([A-Q])/);
    if (cm) cn.push(cm[1]);
  }
  const missingTW = expected.filter((m) => !tw.includes(m));
  const missingCN = expected.filter((m) => !cn.includes(m));
  console.log(`  TW cron methods: ${tw.length}/${expected.length}, missing: ${missingTW.join(',') || '-'}`);
  console.log(`  CN cron methods: ${cn.length}/${expected.length}, missing: ${missingCN.join(',') || '-'}`);
  if (missingTW.length > 0) findings.push({ round: 34, type: 'cron-tw-missing', detail: missingTW.join(','), severity: 'high' });
  if (missingCN.length > 0) findings.push({ round: 34, type: 'cron-cn-missing', detail: missingCN.join(','), severity: 'high' });
}

async function r35() {
  console.log('\n=== R35: LockWatch updater 排程驗證 ===');
  const vercel = JSON.parse(await fs.readFile(path.join(WT_ROOT, 'vercel.json'), 'utf-8')) as { crons: { path: string }[] };
  const lwUpd = vercel.crons.filter((c) => c.path.includes('update-lockwatch'));
  console.log(`  update-lockwatch entries: ${lwUpd.length}（預期 2: TW + CN）`);
  if (lwUpd.length < 2) findings.push({ round: 35, type: 'lockwatch-updater-missing', detail: `${lwUpd.length}/2`, severity: 'high' });
}

async function r36() {
  console.log('\n=== R36: 大盤指數 freshness ===');
  const today = new Date('2026-05-08');
  for (const [market, sym] of [['TW', '^TWII'], ['CN', '000001.SS']] as const) {
    try {
      const l1 = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'data', 'candles', market, `${sym}.json`), 'utf-8')) as { candles: { date: string; close: number }[] };
      const last = l1.candles[l1.candles.length - 1];
      const daysStale = Math.round((today.getTime() - new Date(last.date).getTime()) / 86400_000);
      console.log(`  ${market} ${sym}: ${l1.candles.length} candles, last=${last.date}, ${daysStale}d stale, close=${last.close}`);
      if (daysStale > 3) findings.push({ round: 36, type: 'index-stale', detail: `${sym} ${daysStale}d`, severity: 'high' });
    } catch (err) {
      findings.push({ round: 36, type: 'index-load-fail', detail: `${sym}: ${err}`, severity: 'critical' });
    }
  }
}

async function r37() {
  console.log('\n=== R37: ETF strategy v12 標記 ===');
  // 假設 lib/etf/strategySignals.ts 還沒更新到 J-Q
  const txt = await fs.readFile(path.join(WT_ROOT, 'lib/etf/strategySignals.ts'), 'utf-8');
  const hasJ = txt.includes('J:');
  if (!hasJ) findings.push({ round: 37, type: 'etf-strategy-no-v12', detail: 'StrategySignals interface 缺 J-Q', severity: 'medium' });
  console.log(`  StrategySignals.J: ${hasJ ? '有' : '缺（待補）'}`);
}

async function r38() {
  console.log('\n=== R38: 主動式 ETF 5-digit 處理 ===');
  const files = await fs.readdir(path.join(REPO_ROOT, 'data/candles/TW'));
  const activeETF = files.filter((f) => /^00\d{3}A\.TW\.json$/.test(f));
  console.log(`  主動式 ETF (00xxxA): ${activeETF.length} 個`);
  // 5-digit ETF code 是否能被 watchlist conditions 等處理 — 抽查 1 個
  if (activeETF.length > 0) {
    try {
      const sample = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'data/candles/TW', activeETF[0]), 'utf-8')) as { candles: unknown[] };
      console.log(`  ${activeETF[0]}: ${sample.candles.length} candles`);
    } catch (err) {
      findings.push({ round: 38, type: 'active-etf-load-fail', detail: `${activeETF[0]}: ${err}`, severity: 'medium' });
    }
  }
}

async function r39() {
  console.log('\n=== R39: 已知缺 K 棒股票最新狀態 ===');
  const targets = ['7716.TWO', '7821.TW', '8101.TW'];
  for (const sym of targets) {
    try {
      const l1 = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'data/candles/TW', `${sym}.json`), 'utf-8')) as { candles: { date: string }[] };
      const lastDate = l1.candles[l1.candles.length - 1]?.date ?? 'N/A';
      const daysStale = Math.round((new Date('2026-05-08').getTime() - new Date(lastDate).getTime()) / 86400_000);
      console.log(`  ${sym}: ${l1.candles.length} candles, last=${lastDate} (${daysStale}d stale)`);
      if (daysStale > 5) findings.push({ round: 39, type: 'known-bad-still-stale', symbol: sym, detail: `${daysStale}d`, severity: 'medium' });
    } catch { /* */ }
  }
}

async function r40() {
  console.log('\n=== R40: production 全部 v12 端點 health check ===');
  const endpoints = [
    '/api/health',
    '/api/lockwatch?market=TW',
    '/api/lockwatch?market=CN',
    '/api/scanner/results?market=TW&direction=long&date=2026-05-08&mtf=Q',
    '/api/scanner/results?market=TW&direction=long&date=2026-05-08&mtf=N',
    '/api/scanner/results?market=CN&direction=long&date=2026-05-08&mtf=F',
  ];
  for (const ep of endpoints) {
    try {
      const result = execSync(`curl -s -o /dev/null -w "%{http_code}" 'https://stock-replay-5f24.vercel.app${ep}' -m 15`, { encoding: 'utf-8' }).trim();
      if (result !== '200') findings.push({ round: 40, type: 'prod-endpoint-fail', detail: `${ep}: ${result}`, severity: 'critical' });
      console.log(`  ${ep}: HTTP ${result}`);
    } catch (err) {
      findings.push({ round: 40, type: 'prod-endpoint-error', detail: `${ep}: ${err}`, severity: 'critical' });
    }
  }
}

async function main() {
  console.log(`\nDeep-dig Round 31-40 (${new Date().toISOString()})\n`);
  await r31();
  await r32();
  await r33();
  await r34();
  await r35();
  await r36();
  await r37();
  await r38();
  await r39();
  await r40();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`總發現：${findings.length} 筆`);
  const bySev = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  console.log(`  by severity:`, bySev);
  for (const f of findings) console.log(`  R${f.round} [${f.severity}] ${f.type}: ${f.detail}`);

  const out = path.join(REPO_ROOT, 'data/reports', `audit-rounds-31-40-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: findings.length, findings }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
