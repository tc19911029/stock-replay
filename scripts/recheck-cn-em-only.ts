/**
 * 只重跑 EastMoney 部分（先前 EM 整批 502，需慢速重查）
 * 讀 verify-cn-problem-stocks-report.json，更新 em 欄位 + 重算 verdict
 */
import { promises as fs } from 'fs';
import path from 'path';

const REPORT_FILE = path.join('scripts', 'verify-cn-problem-stocks-report.json');

interface CheckResult {
  symbol: string;
  source: string;
  lastDate?: string;
  daysBehind?: number;
  yahoo: { status: string; lastDate?: string; lastClose?: number };
  em: { status: string; name?: string; price?: number };
  verdict: string;
  reason: string;
}

async function checkEastMoney(sym: string, retries = 3): Promise<CheckResult['em']> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const code = sym.split('.')[0];
      const market = sym.endsWith('.SH') || sym.endsWith('.SS') ? '1' : '0';
      const secid = `${market}.${code}`;
      const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f57,f58,f292`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.status === 502 || res.status === 429) {
        await new Promise(r => setTimeout(r, 3000 + attempt * 2000));
        continue;
      }
      if (!res.ok) return { status: `HTTP_${res.status}` };
      const json = await res.json() as { data?: { f43?: number; f57?: string; f58?: string } };
      if (!json.data || json.data.f57 == null) return { status: 'NO_DATA' };
      const name = json.data.f58;
      const priceRaw = json.data.f43;
      const price = typeof priceRaw === 'number' && priceRaw > 0 ? priceRaw / 100 : undefined;
      return { status: 'OK', name, price };
    } catch (e) {
      if (attempt === retries - 1) {
        return { status: `EXC:${e instanceof Error ? e.message.slice(0,40) : 'unknown'}` };
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return { status: 'HTTP_502' };
}

function deriveVerdict(y: CheckResult['yahoo'], em: CheckResult['em']): { verdict: string; reason: string } {
  const today = new Date().toISOString().slice(0, 10);
  const todayMs = Date.parse(today + 'T00:00:00Z');
  if (y.status !== 'OK' && em.status !== 'OK') {
    return { verdict: 'delisted', reason: `Y=${y.status} EM=${em.status}` };
  }
  const emActive = em.status === 'OK' && (em.price ?? 0) > 0 && !((em.name ?? '').includes('退'));
  if (y.status === 'OK' && y.lastDate) {
    const daysBehind = Math.floor((todayMs - Date.parse(y.lastDate + 'T00:00:00Z')) / 86400000);
    if (daysBehind <= 7) return { verdict: 'recoverable', reason: `Yahoo lastDate=${y.lastDate} → 應補抓` };
    if (daysBehind <= 60) return { verdict: emActive ? 'recoverable' : 'halted', reason: `Yahoo lastDate=${y.lastDate} (${daysBehind}d ago)` };
    return { verdict: emActive ? 'halted' : 'delisted', reason: `Yahoo lastDate=${y.lastDate} (${daysBehind}d ago) EM=${emActive ? em.name : 'inactive'}` };
  }
  if (em.status === 'OK') {
    if ((em.name ?? '').includes('退')) return { verdict: 'delisted', reason: `EM 名稱含「退」: ${em.name}` };
    return { verdict: 'inconclusive', reason: `Yahoo=${y.status} 但 EM 有報價 ${em.name} ${em.price}` };
  }
  return { verdict: 'inconclusive', reason: `Y=${y.status} EM=${em.status}` };
}

async function main() {
  const report = JSON.parse(await fs.readFile(REPORT_FILE, 'utf-8')) as {
    generatedAt: string; counts: Record<string, number>; results: CheckResult[];
  };
  console.log(`==> 重查 EastMoney (${report.results.length} 支，每支間隔 2 秒)`);
  console.log('idx | sym       | EM 名稱        | EM price  | 新 verdict');
  console.log('----|-----------|----------------|-----------|------------');

  for (let i = 0; i < report.results.length; i++) {
    const r = report.results[i];
    const em = await checkEastMoney(r.symbol);
    const old = r.em.status;
    r.em = em;
    const v = deriveVerdict(r.yahoo, em);
    r.verdict = v.verdict;
    r.reason = v.reason;
    const emStr = em.status === 'OK' ? `${(em.name ?? '?').padEnd(12)} ${em.price?.toFixed(2) ?? '-'}` : em.status;
    console.log(`${String(i+1).padStart(3)} | ${r.symbol.padEnd(9)} | ${emStr.padEnd(28)} | ${v.verdict}: ${v.reason.slice(0, 40)}`);
    await new Promise(r => setTimeout(r, 2000));
  }

  // 重新統計
  const counts: Record<string, CheckResult[]> = { delisted: [], halted: [], recoverable: [], inconclusive: [] };
  for (const r of report.results) (counts[r.verdict] ??= []).push(r);
  report.counts = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.length]));

  console.log('\n=== 最終摘要（EM 重查後）===');
  for (const [k, list] of Object.entries(counts)) console.log(`${k}: ${list.length}`);

  await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`\n已更新 ${REPORT_FILE}`);

  // 印出 delisted 名單供 prune 用
  console.log('\n--- delisted 清單 (符合 prune 條件) ---');
  for (const r of counts.delisted) {
    console.log(`  { sym: '${r.symbol}', name: '${r.em.name ?? '-'}' },`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
