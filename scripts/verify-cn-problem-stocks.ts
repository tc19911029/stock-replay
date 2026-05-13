/**
 * 驗證當前 CN 問題股的真實狀態 — 退市 / 停牌 / 可恢復
 *
 * 來源：/api/health/data?market=CN&detail=1
 *   - failedSymbols (103 支讀檔失敗)
 *   - permanentStaleDetails (17 支 >14 天落後)
 *   - 去重後逐支查 Yahoo + EastMoney 雙源
 *
 * 輸出：scripts/verify-cn-problem-stocks-report.json
 *   - delisted: 兩源都掛 → 安全 prune
 *   - halted: Yahoo 有但日期舊（>30 天）→ 真停牌，保留
 *   - recoverable: Yahoo 有近期資料 → 該被 retry-failed 撈回來
 *   - inconclusive: 一源 OK 一源掛 → 人工判斷
 *
 * 用法：npx tsx scripts/verify-cn-problem-stocks.ts
 */

import { promises as fs } from 'fs';
import path from 'path';

const HEALTH_URL = 'http://localhost:3000/api/health/data?market=CN&detail=1';
const REPORT_FILE = path.join('scripts', 'verify-cn-problem-stocks-report.json');

interface VerifyReport {
  failedSymbols?: string[];
  permanentStaleDetails?: { symbol: string; lastDate: string; daysBehind: number }[];
}

interface CheckResult {
  symbol: string;
  source: 'failed' | 'stale' | 'both';
  lastDate?: string;
  daysBehind?: number;
  yahoo: { status: string; lastDate?: string; lastClose?: number };
  em: { status: string; name?: string; price?: number };
  verdict: 'delisted' | 'halted' | 'recoverable' | 'inconclusive';
  reason: string;
}

async function fetchHealth(): Promise<VerifyReport> {
  const envPath = path.join(process.cwd(), '.env.local');
  const env = await fs.readFile(envPath, 'utf-8').catch(() => '');
  const m = env.match(/^CRON_SECRET=(.+)$/m);
  const secret = m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
  const res = await fetch(HEALTH_URL, { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  if (!res.ok) throw new Error(`/api/health/data 回 ${res.status}`);
  const json = await res.json() as { report?: VerifyReport };
  return json.report ?? {};
}

async function checkYahoo(sym: string): Promise<CheckResult['yahoo']> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1y`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.status === 404) return { status: 'DELISTED' };
    if (!res.ok) return { status: `HTTP_${res.status}` };
    const json = await res.json() as { chart?: { result?: { timestamp?: number[]; indicators: { quote: { close: (number|null)[] }[] } }[]; error?: { description?: string } } };
    if (json.chart?.error) return { status: `ERR:${json.chart.error.description ?? 'unknown'}` };
    const r = json.chart?.result?.[0];
    const ts = r?.timestamp;
    if (!ts || ts.length === 0) return { status: 'NO_DATA' };
    const closes = r.indicators.quote[0].close;
    let lastIdx = -1;
    for (let i = ts.length - 1; i >= 0; i--) {
      if (closes[i] != null && closes[i]! > 0) { lastIdx = i; break; }
    }
    if (lastIdx < 0) return { status: 'ALL_NULL' };
    const lastDate = new Date(ts[lastIdx] * 1000).toISOString().slice(0, 10);
    return { status: 'OK', lastDate, lastClose: closes[lastIdx]! };
  } catch (e) {
    return { status: `EXC:${e instanceof Error ? e.message.slice(0,40) : 'unknown'}` };
  }
}

async function checkEastMoney(sym: string): Promise<CheckResult['em']> {
  try {
    const code = sym.split('.')[0];
    const market = sym.endsWith('.SH') || sym.endsWith('.SS') ? '1' : '0';
    const secid = `${market}.${code}`;
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f57,f58,f292`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { status: `HTTP_${res.status}` };
    const json = await res.json() as { data?: { f43?: number; f57?: string; f58?: string } };
    if (!json.data || json.data.f57 == null) return { status: 'NO_DATA' };
    const name = json.data.f58;
    const priceRaw = json.data.f43;
    const price = typeof priceRaw === 'number' && priceRaw > 0 ? priceRaw / 100 : undefined;
    return { status: 'OK', name, price };
  } catch (e) {
    return { status: `EXC:${e instanceof Error ? e.message.slice(0,40) : 'unknown'}` };
  }
}

function deriveVerdict(y: CheckResult['yahoo'], em: CheckResult['em']): { verdict: CheckResult['verdict']; reason: string } {
  const today = new Date().toISOString().slice(0, 10);
  const todayMs = Date.parse(today + 'T00:00:00Z');

  // 兩源都掛 → 退市
  if (y.status !== 'OK' && em.status !== 'OK') {
    return { verdict: 'delisted', reason: `Y=${y.status} EM=${em.status}` };
  }

  // EM 顯示有報價 + 名稱不含「退」字 → 推測有效（若 Yahoo 也 OK 更穩）
  const emActive = em.status === 'OK' && (em.price ?? 0) > 0 && !((em.name ?? '').includes('退'));

  if (y.status === 'OK' && y.lastDate) {
    const daysBehind = Math.floor((todayMs - Date.parse(y.lastDate + 'T00:00:00Z')) / 86400000);
    if (daysBehind <= 7) {
      return { verdict: 'recoverable', reason: `Yahoo 有近期資料 lastDate=${y.lastDate} → 應補抓` };
    }
    if (daysBehind <= 60) {
      // 30-60 天：可能短期停牌但回得來
      return { verdict: emActive ? 'recoverable' : 'halted', reason: `Yahoo lastDate=${y.lastDate} (${daysBehind}d ago)` };
    }
    // > 60 天：真停牌或退市過程中
    return { verdict: emActive ? 'halted' : 'delisted', reason: `Yahoo lastDate=${y.lastDate} (${daysBehind}d ago) EM=${emActive ? 'active' : 'inactive'}` };
  }

  // Yahoo 掛但 EM 有報價 → 不確定（可能 EM 殭屍報價）
  if (em.status === 'OK') {
    if ((em.name ?? '').includes('退')) {
      return { verdict: 'delisted', reason: `EM 名稱含「退」: ${em.name}` };
    }
    return { verdict: 'inconclusive', reason: `Yahoo=${y.status} 但 EM 有報價 ${em.name} ${em.price}` };
  }

  return { verdict: 'inconclusive', reason: `Y=${y.status} EM=${em.status}` };
}

async function main() {
  console.log('==> 從 /api/health/data 取得當前問題股清單');
  const report = await fetchHealth();
  const failed = new Set(report.failedSymbols ?? []);
  const staleMap = new Map<string, { lastDate: string; daysBehind: number }>();
  for (const s of (report.permanentStaleDetails ?? [])) {
    staleMap.set(s.symbol, { lastDate: s.lastDate, daysBehind: s.daysBehind });
  }
  const allProblem = new Set<string>([...failed, ...staleMap.keys()]);
  console.log(`failedSymbols: ${failed.size}, permanentStale: ${staleMap.size}, 去重後: ${allProblem.size}`);

  console.log('\n==> 逐支驗證（Yahoo + EastMoney 雙源，每支間隔 300ms）');
  console.log('Sym       | Yahoo                  | EastMoney              | 判讀');
  console.log('----------|------------------------|------------------------|------------------');
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const results: CheckResult[] = [];

  let idx = 0;
  for (const sym of allProblem) {
    idx++;
    const [y, em] = await Promise.all([checkYahoo(sym), checkEastMoney(sym)]);
    const { verdict, reason } = deriveVerdict(y, em);
    const yStr = y.status === 'OK' ? `${y.lastDate} ${y.lastClose?.toFixed(2)}`.padEnd(22) : y.status.padEnd(22);
    const emStr = em.status === 'OK' ? `${(em.name ?? '?').padEnd(8)} ${em.price?.toFixed(2) ?? '-'}`.padEnd(22) : em.status.padEnd(22);
    const stale = staleMap.get(sym);
    const source: CheckResult['source'] = failed.has(sym) && stale ? 'both' : (failed.has(sym) ? 'failed' : 'stale');

    results.push({
      symbol: sym, source,
      lastDate: stale?.lastDate, daysBehind: stale?.daysBehind,
      yahoo: y, em,
      verdict, reason,
    });

    console.log(`[${idx}/${allProblem.size}] ${sym.padEnd(10)} | ${yStr} | ${emStr} | ${verdict}: ${reason.slice(0, 40)}`);
    await sleep(300);
  }

  // ── 統計 ────────────────────────────────────────────────────
  const counts: Record<string, CheckResult[]> = { delisted: [], halted: [], recoverable: [], inconclusive: [] };
  for (const r of results) counts[r.verdict].push(r);

  console.log('\n=== 摘要 ===');
  console.log(`delisted（兩源都掛 / 名稱含「退」/ EM 也 inactive）: ${counts.delisted.length}`);
  console.log(`halted（真長期停牌，仍掛牌）: ${counts.halted.length}`);
  console.log(`recoverable（Yahoo 有近期資料，該補抓）: ${counts.recoverable.length}`);
  console.log(`inconclusive（單源 OK，需人工確認）: ${counts.inconclusive.length}`);

  console.log('\n--- delisted 清單（建議 prune）---');
  for (const r of counts.delisted) console.log(`  ${r.symbol}\t${r.em.name ?? '-'}\t${r.reason}`);

  console.log('\n--- recoverable 清單（建議 retry-failed）---');
  for (const r of counts.recoverable) console.log(`  ${r.symbol}\t${r.yahoo.lastDate ?? '-'}\t${r.reason}`);

  console.log('\n--- halted 清單（保留不刪）---');
  for (const r of counts.halted) console.log(`  ${r.symbol}\t${r.yahoo.lastDate ?? '-'}\t${r.reason}`);

  console.log('\n--- inconclusive 清單（人工判斷）---');
  for (const r of counts.inconclusive) console.log(`  ${r.symbol}\t${r.reason}`);

  // 寫報告
  await fs.writeFile(REPORT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.length])),
    results,
  }, null, 2));
  console.log(`\n報告已寫入：${REPORT_FILE}`);
  console.log('下一步：');
  console.log('  - delisted 清單 → 移到 scripts/prune-cn-delisted.ts，跑一次清理');
  console.log('  - recoverable → 跑 retry-failed cron');
  console.log('  - halted → 不動（資料源已有，等復牌）');
  console.log('  - inconclusive → 看 EM 名稱判斷');
}

main().catch(e => { console.error(e); process.exit(1); });
