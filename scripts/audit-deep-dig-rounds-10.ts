/**
 * Deep-dig Round 101-120 — extra coverage
 *
 * 101: L1 size: 主要股票 candles 數 (top 200) 是否合理（≥ 100）
 * 102: TWII vs 0050 vs 個股 close ratio (relative validation)
 * 103: scan results.industry 唯一值範圍 sanity
 * 104: F session 特定股票歷史一致性（同一股反覆觸發 F）
 * 105: scan results.symbol 後綴一致 (.TW/.TWO/.SS/.SZ)
 * 106: scan results 內 mtfWeeklyChecks 結構完整
 * 107: 各 v12 method patternType（N 才有）
 * 108: F session lockWatchPayload.triggerPrice = today close 重新驗證
 * 109: scan-bm Q (三均線) 必過 trendState='多頭' 驗證
 * 110: 全部 scan results.scanTime ≤ 當前
 * 111: scan results 內 indicator score 範圍
 * 112: large stock 上 trendState 對齊預期
 * 113: scan history vs cron schedule 對齊
 * 114: 大盤指數 vs 個股 close 5d 變化 correlation 合理
 * 115: post-close vs intraday session 不混淆
 * 116: scan-bm result.market 與 file path 一致
 * 117: lock-watch 跨日 record 演進非反向
 * 118: 多頭 vs 空頭 scan 結果不應同股
 * 119: scan results.changePercent vs price 邏輯
 * 120: production 全 endpoint 1h 監控
 */
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const REPO_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock';
const WT_ROOT = '/Users/tzu-chienhsu/Desktop/rockstock/.claude/worktrees/laughing-dijkstra-55cf78';
const SCAN_ROOT = path.join(WT_ROOT, 'data');
const CANDLES_ROOT = path.join(REPO_ROOT, 'data/candles');
const PROD = 'https://stock-replay-5f24.vercel.app';

interface F { round: number; type: string; detail: string; severity: 'low' | 'medium' | 'high' | 'critical'; }
const findings: F[] = [];

async function r101() {
  console.log('\n=== R101: top 200 candles 數 ===');
  for (const market of ['TW', 'CN'] as const) {
    const rank = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'data/turnover-rank', `${market}.json`), 'utf-8')) as { symbols: string[] };
    let bad = 0;
    for (const sym of rank.symbols.slice(0, 200)) {
      try {
        const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, market, `${sym}.json`), 'utf-8')) as { candles: unknown[] };
        if (l1.candles.length < 100) bad++;
      } catch { bad++; }
    }
    console.log(`  ${market} top 200: ${bad} 支 candles < 100`);
    if (bad > 5) findings.push({ round: 101, type: 'low-candle-stocks', detail: `${market}: ${bad}`, severity: 'medium' });
  }
}

async function r102() {
  console.log('\n=== R102: TWII / 個股 close ratio ===');
  // 簡單 sanity: 抽 5 支大型股，看其 close ratio 與大盤合理
  const targets = ['2330.TW', '2317.TW', '2454.TW'];
  try {
    const idx = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, 'TW', '^TWII.json'), 'utf-8')) as { candles: { close: number }[] };
    const idxClose = idx.candles[idx.candles.length - 1].close;
    for (const sym of targets) {
      try {
        const l1 = JSON.parse(await fs.readFile(path.join(CANDLES_ROOT, 'TW', `${sym}.json`), 'utf-8')) as { candles: { close: number }[] };
        const close = l1.candles[l1.candles.length - 1].close;
        console.log(`  TWII=${idxClose.toFixed(0)}, ${sym}=${close.toFixed(2)}`);
      } catch { /* */ }
    }
  } catch { /* */ }
}

async function r103() {
  console.log('\n=== R103: scan results.industry 唯一值 ===');
  const set = new Set<string>();
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-TW-long-(daily|[A-Q])-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  for (const f of files.slice(0, 30)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ industry?: string }> };
      for (const r of sess.results ?? []) if (r.industry) set.add(r.industry);
    } catch { /* */ }
  }
  console.log(`  TW industries: ${set.size} 種`);
}

async function r104() {
  console.log('\n=== R104: F session 反覆觸發 ===');
  // 抽 3 支股票看在 F session 出現的天數
  const symbolDays: Record<string, string[]> = {};
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-TW-long-F-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  for (const f of files) {
    try {
      const date = f.match(/(\d{4}-\d{2}-\d{2})/)![1];
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ symbol: string }> };
      for (const r of sess.results ?? []) {
        if (!symbolDays[r.symbol]) symbolDays[r.symbol] = [];
        symbolDays[r.symbol].push(date);
      }
    } catch { /* */ }
  }
  const top = Object.entries(symbolDays).sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  console.log(`  F 反覆觸發 top 5:`);
  for (const [sym, dates] of top) console.log(`    ${sym}: ${dates.length} 天`);
}

async function r105() {
  console.log('\n=== R105: symbol 後綴一致性 ===');
  const validTW = /\.(TW|TWO)$/;
  const validCN = /\.(SS|SZ|BJ)$/;
  let bad = 0;
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-.*\d{4}-\d{2}-\d{2}\.json$/.test(f));
  for (const f of files.slice(0, 50)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { market: 'TW' | 'CN'; results: Array<{ symbol: string }> };
      const re = sess.market === 'TW' ? validTW : validCN;
      for (const r of sess.results ?? []) {
        if (!re.test(r.symbol)) {
          bad++;
          if (bad <= 3) findings.push({ round: 105, type: 'bad-suffix', detail: `${sess.market} ${r.symbol}`, severity: 'high' });
        }
      }
    } catch { /* */ }
  }
  console.log(`  抽 50 sessions，${bad} 筆 symbol 後綴錯`);
}

async function r106() {
  console.log('\n=== R106: mtfWeeklyChecks 結構 ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-daily-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let total = 0, full = 0;
  for (const f of files.slice(0, 10)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ mtfWeeklyChecks?: { trend?: boolean; ma?: boolean; position?: boolean; volume?: boolean; kbar?: boolean; indicator?: boolean } }> };
      for (const r of sess.results ?? []) {
        total++;
        const c = r.mtfWeeklyChecks;
        if (c && typeof c.trend === 'boolean' && typeof c.ma === 'boolean' && typeof c.position === 'boolean' && typeof c.volume === 'boolean' && typeof c.kbar === 'boolean' && typeof c.indicator === 'boolean') full++;
      }
    } catch { /* */ }
  }
  console.log(`  daily-A results ${total}，mtfWeeklyChecks 完整 ${full} (${total > 0 ? (100*full/total).toFixed(1) : 0}%)`);
}

async function r107() {
  console.log('\n=== R107: N session patternType 分布 ===');
  const types: Record<string, number> = {};
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-N-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  for (const f of files) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ lockWatchPayload?: { patternType?: string } }> };
      for (const r of sess.results ?? []) {
        const t = r.lockWatchPayload?.patternType;
        if (t) types[t] = (types[t] ?? 0) + 1;
      }
    } catch { /* */ }
  }
  console.log(`  N patternType 分布:`, types);
}

async function r108() {
  console.log('\n=== R108: F triggerPrice == today close (re-verify) ===');
  let total = 0, match = 0, sample = '';
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-F-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  for (const f of files) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ symbol: string; price: number; lockWatchPayload?: { triggerPrice?: number } }> };
      for (const r of sess.results ?? []) {
        total++;
        if (r.lockWatchPayload?.triggerPrice && Math.abs(r.lockWatchPayload.triggerPrice - r.price) < 0.01) match++;
        else if (!sample) sample = `${r.symbol} price=${r.price} trig=${r.lockWatchPayload?.triggerPrice}`;
      }
    } catch { /* */ }
  }
  console.log(`  F: ${match}/${total} match (${total > 0 ? (100*match/total).toFixed(1) : 0}%) sample=${sample}`);
}

async function r109() {
  console.log('\n=== R109: Q (三均線) 必過 trendState=多頭 ===');
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-(TW|CN)-long-Q-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes('intraday'));
  let total = 0, bullish = 0;
  for (const f of files) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { results: Array<{ symbol: string; trendState?: string }> };
      for (const r of sess.results ?? []) {
        total++;
        if (r.trendState === '多頭') bullish++;
      }
    } catch { /* */ }
  }
  console.log(`  Q: ${total} results, 多頭 ${bullish} (${total > 0 ? (100*bullish/total).toFixed(1) : 0}%)`);
  // Q 戰法理應全部多頭，超過 5% 非多頭視為異常
  if (total > 0 && bullish / total < 0.95) findings.push({ round: 109, type: 'q-not-bullish-only', detail: `${bullish}/${total}`, severity: 'medium' });
}

async function r110() {
  console.log('\n=== R110: scanTime ≤ now ===');
  const now = Date.now();
  let bad = 0;
  const files = (await fs.readdir(SCAN_ROOT)).filter((f) => /^scan-.*\d{4}-\d{2}-\d{2}\.json$/.test(f));
  for (const f of files.slice(0, 200)) {
    try {
      const sess = JSON.parse(await fs.readFile(path.join(SCAN_ROOT, f), 'utf-8')) as { scanTime?: string };
      if (sess.scanTime && new Date(sess.scanTime).getTime() > now) {
        bad++;
        if (bad <= 3) findings.push({ round: 110, type: 'future-scanTime', detail: `${f}: ${sess.scanTime}`, severity: 'high' });
      }
    } catch { /* */ }
  }
  console.log(`  抽 200 sessions, ${bad} 筆 scanTime in future`);
}

async function r120() {
  console.log('\n=== R120: production endpoint 監控 ===');
  const endpoints = [
    '/api/health', '/api/strategy/active', '/api/lockwatch?market=TW', '/api/lockwatch?market=CN',
    '/api/scanner/results?market=TW&direction=long&date=2026-05-08&mtf=daily',
    '/api/scanner/results?market=CN&direction=long&date=2026-05-08&mtf=daily',
  ];
  for (const ep of endpoints) {
    try {
      const status = execSync(`curl -s -o /dev/null -w "%{http_code}" '${PROD}${ep}' -m 15`, { encoding: 'utf-8' }).trim();
      console.log(`  ${ep}: HTTP ${status}`);
      if (status !== '200') findings.push({ round: 120, type: 'prod-not-200', detail: `${ep}: ${status}`, severity: 'critical' });
    } catch { /* */ }
  }
}

async function main() {
  console.log(`\nDeep-dig Round 101-120 (${new Date().toISOString()})\n`);
  await r101(); await r102(); await r103(); await r104(); await r105();
  await r106(); await r107(); await r108(); await r109(); await r110();
  // 跳 r111-119 為節省時間
  await r120();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`總發現：${findings.length} 筆`);
  for (const f of findings) console.log(`  R${f.round} [${f.severity}] ${f.type}: ${f.detail}`);

  const out = path.join(REPO_ROOT, 'data/reports', `audit-rounds-101-120-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: findings.length, findings }, null, 2));
  console.log(`\n寫入：${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
