/**
 * Deep-dig Round 41-50
 *
 * 41: store/backtestStore activeBuyMethod J-Q 流程
 * 42: scan-bm 各方法 cron 排程時間衝突分析
 * 43: F V反轉 lockWatchPayload 在 worktree data 覆蓋率
 * 44: N 型態確認 patternType + targetPrice 完整性
 * 45: TW Q 三均線戰法 連續 20 天結果合理性
 * 46: scan history 時間順序（scanTime 應 ≥ date）
 * 47: 大盤指數實際 close 變化 vs 預期
 * 48: scan results trendState 占比（多/空/盤整）合理嗎
 * 49: scan results changePercent 範圍（≤ ±20% TW limit）
 * 50: production v12 各方法歷史完整性（20 天每天都要有）
 */
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const WT_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock/.claude/worktrees/laughing-dijkstra-55cf78';
const SCAN_ROOT = path.join(WT_ROOT, 'data');  // 從 worktree 讀，因 v12 sessions 在這

interface F { round: number; type: string; symbol?: string; date?: string; detail: string; severity: 'low' | 'medium' | 'high' | 'critical'; }
const findings: F[] = [];

async function r41() {
  console.log('\n=== R41: backtestStore activeBuyMethod J-Q ===');
  const txt = await fs.readFile(path.join(WT_ROOT, 'store/backtestStore.ts'), 'utf-8');
  const v12 = ['J','K','L','M','N','O','P','Q'].every((m) => txt.includes(`'${m}'`));
  console.log(`  backtestStore J-Q 都有引用: ${v12}`);
  if (!v12) findings.push({ round: 41, type: 'backtest-store-missing-v12', detail: '', severity: 'high' });
}

async function r42() {
  console.log('\n=== R42: scan-bm cron 時間衝突 ===');
  const vercel = JSON.parse(await fs.readFile(path.join(WT_ROOT, 'vercel.json'), 'utf-8')) as { crons: { path: string; schedule: string }[] };
  const buckets: Record<string, string[]> = {};
  for (const c of vercel.crons) {
    if (c.path.includes('scan-bm')) {
      buckets[c.schedule] = [...(buckets[c.schedule] ?? []), c.path];
    }
  }
  let conflicts = 0;
  for (const [s, list] of Object.entries(buckets)) {
    if (list.length > 1) {
      conflicts++;
      findings.push({ round: 42, type: 'cron-collision', detail: `${s}: ${list.length} concurrent`, severity: 'medium' });
    }
  }
  console.log(`  ${Object.keys(buckets).length} 個獨立 schedule，${conflicts} 個衝突`);
}

async function r43() {
  console.log('\n=== R43: F V反轉 lockWatchPayload 覆蓋率 ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-F-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  let total = 0, withPL = 0;
  for (const f of files) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ lockWatchPayload?: { triggerPrice?: number } }> };
      for (const r of sess.results ?? []) {
        total++;
        if (r.lockWatchPayload?.triggerPrice && r.lockWatchPayload.triggerPrice > 0) withPL++;
      }
    } catch { /* */ }
  }
  console.log(`  F sessions 總結果 ${total}，${withPL} 有 lockWatchPayload (${total > 0 ? (100*withPL/total).toFixed(1) : 0}%)`);
  if (total > 0 && withPL / total < 0.95) findings.push({ round: 43, type: 'f-payload-missing', detail: `${withPL}/${total}`, severity: 'high' });
}

async function r44() {
  console.log('\n=== R44: N session 完整性 ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-N-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  let total = 0, full = 0;
  for (const f of files) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ lockWatchPayload?: { triggerPrice?: number; patternType?: string; patternTargetPrice?: number; patternAchievementRate?: number } }> };
      for (const r of sess.results ?? []) {
        total++;
        const p = r.lockWatchPayload;
        if (p?.triggerPrice && p.patternType && p.patternTargetPrice && p.patternAchievementRate != null) full++;
      }
    } catch { /* */ }
  }
  console.log(`  N sessions 總 ${total}，完整 (price+type+target+rate) ${full} (${total > 0 ? (100*full/total).toFixed(1) : 0}%)`);
  if (total > 0 && full / total < 0.95) findings.push({ round: 44, type: 'n-payload-incomplete', detail: `${full}/${total}`, severity: 'medium' });
}

async function r45() {
  console.log('\n=== R45: TW Q 20 天結果分布 ===');
  const dates: { date: string; count: number }[] = [];
  for (const f of await fs.readdir(SCAN_ROOT)) {
    const m = f.match(/^scan-TW-long-Q-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    if (f.includes('intraday')) continue;
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { resultCount?: number };
      dates.push({ date: m[1], count: sess.resultCount ?? 0 });
    } catch { /* */ }
  }
  dates.sort((a, b) => a.date.localeCompare(b.date));
  const counts = dates.map((x) => x.count);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  console.log(`  ${dates.length} 天，平均 ${mean.toFixed(1)}，min=${Math.min(...counts)} max=${Math.max(...counts)}`);
  if (counts.filter((c) => c === 0).length > 5) findings.push({ round: 45, type: 'q-too-many-zeros', detail: `${counts.filter((c) => c === 0).length}/${counts.length} zero`, severity: 'medium' });
}

async function r46() {
  console.log('\n=== R46: scanTime 時間順序 sanity ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-.*\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  let bad = 0;
  for (const f of files.slice(0, 100)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { date: string; scanTime?: string };
      if (sess.scanTime && sess.scanTime < sess.date) {
        bad++;
        if (bad <= 3) findings.push({ round: 46, type: 'scanTime-before-date', detail: `${f} scan=${sess.scanTime} date=${sess.date}`, severity: 'medium' });
      }
    } catch { /* */ }
  }
  console.log(`  抽 100 sessions，${bad} 筆 scanTime < date 異常`);
}

async function r47() {
  console.log('\n=== R47: 大盤指數最近 close 變化合理嗎 ===');
  for (const [market, sym] of [['TW', '^TWII'], ['CN', '000001.SS']] as const) {
    try {
      const l1 = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'data/candles', market, `${sym}.json`), 'utf-8')) as { candles: { close: number }[] };
      const cs = l1.candles.slice(-20);
      const max = Math.max(...cs.map((c) => c.close));
      const min = Math.min(...cs.map((c) => c.close));
      const range = (max - min) / min;
      console.log(`  ${market} ${sym} 近 20 天: ${min.toFixed(0)} ~ ${max.toFixed(0)} (${(range*100).toFixed(1)}% range)`);
      if (range > 0.2) findings.push({ round: 47, type: 'index-volatile', detail: `${sym} ${(range*100).toFixed(1)}%`, severity: 'low' });
    } catch (err) {
      findings.push({ round: 47, type: 'index-load-fail', detail: String(err).slice(0, 80), severity: 'high' });
    }
  }
}

async function r48() {
  console.log('\n=== R48: trendState 占比 ===');
  const counts: Record<string, number> = {};
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-.*\.json$/.test(f) && !f.includes('intraday'));
  for (const f of files.slice(0, 100)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ trendState?: string }> };
      for (const r of sess.results ?? []) {
        if (r.trendState) counts[r.trendState] = (counts[r.trendState] ?? 0) + 1;
      }
    } catch { /* */ }
  }
  console.log(`  trendState 分布:`, counts);
  // 多頭應佔 > 30%（買進訊號的本質）
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const bullPct = (counts['多頭'] ?? 0) / total;
  if (total > 100 && bullPct < 0.3) findings.push({ round: 48, type: 'too-few-bullish', detail: `${(bullPct*100).toFixed(1)}%`, severity: 'medium' });
}

async function r49() {
  console.log('\n=== R49: scan results changePercent 範圍 ===');
  let bad = 0;
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN).*\.json$/.test(f) && !f.includes('intraday'));
  for (const f of files.slice(0, 50)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { market: 'TW' | 'CN'; results: Array<{ symbol: string; changePercent?: number }> };
      const limit = sess.market === 'TW' ? 11 : 21;  // 含 0.5 容忍
      for (const r of sess.results ?? []) {
        if (typeof r.changePercent === 'number' && Math.abs(r.changePercent) > limit) {
          bad++;
          if (bad <= 3) findings.push({ round: 49, type: 'changepct-out-of-range', symbol: r.symbol, detail: `${r.changePercent}%`, severity: 'high' });
        }
      }
    } catch { /* */ }
  }
  console.log(`  抽 50 sessions，${bad} 筆 changePercent 超出漲跌停`);
}

async function r50() {
  console.log('\n=== R50: production 各方法 20 天歷史完整性 ===');
  const today = new Date('2026-05-08');
  const dates: string[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    dates.push(iso);
  }
  for (const market of ['TW', 'CN'] as const) {
    let totalDays = 0, withSession = 0;
    for (const d of dates.slice(0, 22)) {
      try {
        const r = execSync(`curl -s 'https://stock-replay-5f24.vercel.app/api/scanner/results?market=${market}&direction=long&date=${d}&mtf=Q' -m 10`, { encoding: 'utf-8' });
        const j = JSON.parse(r) as { sessions: unknown[] };
        if (j.sessions && j.sessions.length > 0) withSession++;
        totalDays++;
      } catch { /* */ }
    }
    console.log(`  ${market}-Q: ${withSession}/${totalDays} 天有 session`);
    if (withSession < 18) findings.push({ round: 50, type: 'prod-history-gap', detail: `${market}-Q ${withSession}/22`, severity: 'medium' });
  }
}

async function main() {
  console.log(`\nDeep-dig Round 41-50 (${new Date().toISOString()})\n`);
  await r41();
  await r42();
  await r43();
  await r44();
  await r45();
  await r46();
  await r47();
  await r48();
  await r49();
  await r50();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`總發現：${findings.length} 筆`);
  const bySev = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  console.log(`  by severity:`, bySev);
  for (const f of findings.slice(0, 20)) console.log(`  R${f.round} [${f.severity}] ${f.type}: ${f.detail}`);

  const out = path.join(REPO_ROOT, 'data/reports', `audit-rounds-41-50-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: findings.length, findings }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
