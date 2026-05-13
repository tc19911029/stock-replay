/**
 * 用 Tencent qt.gtimg.cn 重查 CN 問題股（EM API 整批 502 時備援）
 *
 * Tencent 回應格式（GBK encoded）：
 *   v_shXXXXXX="1~名稱~代號~現價~昨收~開盤~成交量~...~時間~..."
 *
 * 判讀：
 *   - volume>0 + price>0 + 名稱不含「退」 → 活躍 active
 *   - volume=0 + 名稱有但 price 凍結 → halted/delisted
 *   - 完全沒回應或 v_xxx=""（空）→ delisted
 *
 * 用法：npx tsx scripts/recheck-cn-tencent.ts
 */
import { promises as fs } from 'fs';
import path from 'path';
import iconv from 'iconv-lite';

const REPORT_FILE = path.join('scripts', 'verify-cn-problem-stocks-report.json');

interface CheckResult {
  symbol: string;
  source: string;
  lastDate?: string;
  daysBehind?: number;
  yahoo: { status: string; lastDate?: string; lastClose?: number };
  em: { status: string; name?: string; price?: number };
  tencent?: { status: string; name?: string; price?: number; volume?: number };
  verdict: string;
  reason: string;
}

function symToTencent(sym: string): string {
  const code = sym.split('.')[0];
  const isSS = sym.endsWith('.SS') || sym.endsWith('.SH');
  return (isSS ? 'sh' : 'sz') + code;
}

async function checkTencent(sym: string): Promise<NonNullable<CheckResult['tencent']>> {
  try {
    const tcSym = symToTencent(sym);
    const url = `http://qt.gtimg.cn/q=${tcSym}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { status: `HTTP_${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const text = iconv.decode(buf, 'gbk');
    // v_sh600519="1~名稱~代號~現價~昨收~開盤~成交量~..."
    const match = text.match(new RegExp(`v_${tcSym}="([^"]*)"`));
    if (!match || !match[1]) return { status: 'EMPTY' };
    const fields = match[1].split('~');
    if (fields.length < 7) return { status: 'BAD_FORMAT' };
    const name = fields[1];
    const price = parseFloat(fields[3] || '0');
    const volume = parseInt(fields[6] || '0', 10);
    if (!name || price === 0) return { status: 'NO_DATA' };
    return { status: 'OK', name, price, volume };
  } catch (e) {
    return { status: `EXC:${e instanceof Error ? e.message.slice(0,40) : 'unknown'}` };
  }
}

function deriveVerdict(y: CheckResult['yahoo'], tc: NonNullable<CheckResult['tencent']>): { verdict: string; reason: string } {
  const today = new Date().toISOString().slice(0, 10);
  const todayMs = Date.parse(today + 'T00:00:00Z');

  // Tencent 完全沒回應 + Yahoo 也沒 → 退市
  if (tc.status !== 'OK' && (y.status === 'DELISTED' || y.status === 'NO_DATA')) {
    return { verdict: 'delisted', reason: `Y=${y.status} TC=${tc.status}` };
  }

  // 名稱含「退」字 → 必為退市
  if (tc.status === 'OK' && (tc.name ?? '').includes('退')) {
    return { verdict: 'delisted', reason: `Tencent 名稱「${tc.name}」含退` };
  }

  // Tencent OK 但 volume=0 + Yahoo 也 stale → 長期停牌或退市
  if (tc.status === 'OK' && (tc.volume ?? 0) === 0) {
    if (y.status === 'DELISTED' || y.status === 'NO_DATA') {
      return { verdict: 'delisted', reason: `TC volume=0 名稱=${tc.name} + Yahoo=${y.status}` };
    }
    return { verdict: 'halted', reason: `TC volume=0 但 Yahoo=${y.status}` };
  }

  // Tencent 有交易量 + 名稱 → active
  if (tc.status === 'OK' && (tc.volume ?? 0) > 0) {
    if (y.status === 'OK' && y.lastDate) {
      const daysBehind = Math.floor((todayMs - Date.parse(y.lastDate + 'T00:00:00Z')) / 86400000);
      if (daysBehind <= 7) return { verdict: 'recoverable', reason: `Both active, Yahoo lastDate=${y.lastDate}` };
    }
    return { verdict: 'recoverable', reason: `TC active 名稱=${tc.name} price=${tc.price} vol=${tc.volume}` };
  }

  return { verdict: 'inconclusive', reason: `Y=${y.status} TC=${tc.status}` };
}

async function main() {
  const report = JSON.parse(await fs.readFile(REPORT_FILE, 'utf-8')) as {
    generatedAt: string; counts: Record<string, number>; results: CheckResult[];
  };
  console.log(`==> 用 Tencent 重查 ${report.results.length} 支問題股（每支間隔 500ms）`);
  console.log('idx | sym       | TC 名稱 | price  | volume | verdict');
  console.log('----|-----------|---------|--------|--------|--------');

  for (let i = 0; i < report.results.length; i++) {
    const r = report.results[i];
    const tc = await checkTencent(r.symbol);
    r.tencent = tc;
    const v = deriveVerdict(r.yahoo, tc);
    r.verdict = v.verdict;
    r.reason = v.reason;
    const tcStr = tc.status === 'OK' ? `${(tc.name ?? '?').slice(0,8).padEnd(8)} ${(tc.price ?? 0).toFixed(2).padEnd(7)} ${tc.volume ?? 0}` : tc.status;
    console.log(`${String(i+1).padStart(3)} | ${r.symbol.padEnd(9)} | ${tcStr.padEnd(28)} | ${v.verdict}: ${v.reason.slice(0, 30)}`);
    await new Promise(r => setTimeout(r, 500));
  }

  // 重新統計
  const counts: Record<string, CheckResult[]> = { delisted: [], halted: [], recoverable: [], inconclusive: [] };
  for (const r of report.results) (counts[r.verdict] ??= []).push(r);
  report.counts = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.length]));

  console.log('\n=== 最終摘要（Tencent 重查後）===');
  for (const [k, list] of Object.entries(counts)) console.log(`${k}: ${list.length}`);

  await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`\n已更新 ${REPORT_FILE}`);

  console.log('\n--- delisted 清單（建議 prune）---');
  for (const r of counts.delisted) {
    const name = r.tencent?.name ?? r.em.name ?? '-';
    console.log(`  { sym: '${r.symbol}', name: '${name}' },`);
  }
  if (counts.recoverable.length > 0) {
    console.log('\n--- recoverable 清單（不該 prune，應補抓）---');
    for (const r of counts.recoverable) {
      console.log(`  ${r.symbol}\t${r.tencent?.name ?? '-'}\t${r.reason}`);
    }
  }
  if (counts.halted.length > 0) {
    console.log('\n--- halted 清單（保留不刪）---');
    for (const r of counts.halted) console.log(`  ${r.symbol}\t${r.tencent?.name ?? '-'}\t${r.reason}`);
  }
  if (counts.inconclusive.length > 0) {
    console.log('\n--- inconclusive 清單（人工判斷）---');
    for (const r of counts.inconclusive) console.log(`  ${r.symbol}\t${r.reason}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
