/**
 * 查證 16 支 CN 長期停滯股的當前狀態（退市 vs 長期停牌）
 * 雙源：Yahoo + EastMoney 個股 quote
 */
const STALE = [
  '000584.SZ', '000622.SZ', '000861.SZ', '000982.SZ', '000996.SZ',
  '002087.SZ', '002336.SZ', '002433.SZ', '002505.SZ', '002750.SZ',
  '600297.SS', '600321.SS', '600705.SS', '600837.SS', '601028.SS', '601989.SS',
];

interface Result {
  sym: string;
  yahooStatus: string;
  yahooLast?: string;
  yahooLastClose?: number;
  emStatus: string;
  emName?: string;
  emPrice?: number;
}

async function checkYahoo(sym: string): Promise<{ status: string; lastDate?: string; lastClose?: number }> {
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

/** EastMoney 個股 quote (push2) — 即時報價來判斷活躍程度 */
async function checkEastMoney(sym: string): Promise<{ status: string; name?: string; price?: number }> {
  try {
    const code = sym.split('.')[0];
    const market = sym.endsWith('.SH') || sym.endsWith('.SS') ? '1' : '0';
    const secid = `${market}.${code}`;
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f57,f58,f292`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { status: `HTTP_${res.status}` };
    const json = await res.json() as { data?: { f43?: number; f57?: string; f58?: string; f292?: string } };
    if (!json.data || json.data.f57 == null) return { status: 'NO_DATA' };
    const name = json.data.f58;
    const priceRaw = json.data.f43;
    const price = typeof priceRaw === 'number' && priceRaw > 0 ? priceRaw / 100 : undefined;
    return { status: 'OK', name, price };
  } catch (e) {
    return { status: `EXC:${e instanceof Error ? e.message.slice(0,40) : 'unknown'}` };
  }
}

async function main() {
  console.log('Sym       | Yahoo                  | EastMoney            | 判讀');
  console.log('----------|------------------------|----------------------|------------------');
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const results: Result[] = [];
  for (const sym of STALE) {
    const [y, em] = await Promise.all([checkYahoo(sym), checkEastMoney(sym)]);
    const yStr = y.status === 'OK' ? `${y.lastDate} ${y.lastClose?.toFixed(2)}`.padEnd(22) : y.status.padEnd(22);
    const emStr = em.status === 'OK' ? `${em.name ?? '?'} ${em.price?.toFixed(2) ?? '-'}`.padEnd(20) : em.status.padEnd(20);

    let verdict = '';
    if (y.status !== 'OK' && em.status !== 'OK') verdict = '🚫 兩源都掛（疑退市）';
    else if (y.status === 'OK' && em.status === 'OK') {
      const yDate = y.lastDate!;
      if (yDate >= '2026-04-01') verdict = '✅ 兩源都活著 → 應補抓';
      else verdict = `⏸ Yahoo 也只到 ${yDate} → 真停牌`;
    }
    else if (y.status === 'OK') verdict = '⚠️ 只 Yahoo 有，EM 掛';
    else if (em.status === 'OK') verdict = '⚠️ 只 EM 有，Yahoo 掛';

    console.log(`${sym.padEnd(10)} | ${yStr} | ${emStr} | ${verdict}`);
    results.push({
      sym, yahooStatus: y.status, yahooLast: y.lastDate, yahooLastClose: y.lastClose,
      emStatus: em.status, emName: em.name, emPrice: em.price
    });
    await sleep(300);
  }

  console.log('\n--- 摘要 ---');
  const delisted = results.filter(r => r.yahooStatus !== 'OK' && r.emStatus !== 'OK');
  const halted = results.filter(r => r.yahooStatus === 'OK' && r.yahooLast && r.yahooLast < '2026-04-01');
  const recoverable = results.filter(r => r.yahooStatus === 'OK' && r.yahooLast && r.yahooLast >= '2026-04-01');
  console.log(`兩源都掛（疑退市，可從清單剔除）: ${delisted.length}`);
  for (const r of delisted) console.log(`  ${r.sym}`);
  console.log(`真長期停牌（兩源都只到舊日期）: ${halted.length}`);
  for (const r of halted) console.log(`  ${r.sym}: yahoo last=${r.yahooLast}`);
  console.log(`可補抓（Yahoo 有近期資料）: ${recoverable.length}`);
  for (const r of recoverable) console.log(`  ${r.sym}: yahoo last=${r.yahooLast}`);
}

main().catch(e => { console.error(e); process.exit(1); });
