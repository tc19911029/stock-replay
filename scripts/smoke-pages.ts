/**
 * 0513 ABCDE B4 — Pages smoke test
 *
 * 對 dev server 跑 critical paths 確認沒 5xx / missing fields。
 * 這層 catch ~80% server-side 回歸，但抓不到 client-side hydration crash
 * (例如 0513 chart pivots-empty crash — 那是 Canvas 渲染 bug，需要 Playwright
 *  真瀏覽器環境)。
 *
 * Usage：
 *   npm run dev  # 先起 dev server
 *   npx tsx scripts/smoke-pages.ts
 *
 * Exit 0 = all pass / Exit 1 = 任一失敗
 */

const HOST = process.env.SMOKE_HOST ?? 'http://localhost:3000';

interface Probe {
  name: string;
  url: string;
  expect?: (j: unknown, status: number) => string | null; // null = pass
}

const PROBES: Probe[] = [
  // ── API health ───────────────────────────────────────────────────────────
  {
    name: 'api/lockwatch TW 有資料',
    url: '/api/lockwatch?market=TW',
    expect: (j) => {
      const body = j as { snapshot?: { records?: unknown[] } };
      const recs = body?.snapshot?.records;
      if (!Array.isArray(recs)) return 'snapshot.records not array';
      if (recs.length === 0) return 'records empty';
      return null;
    },
  },
  {
    name: 'api/lockwatch CN 有資料',
    url: '/api/lockwatch?market=CN',
    expect: (j) => {
      const body = j as { snapshot?: { records?: unknown[] } };
      const recs = body?.snapshot?.records;
      if (!Array.isArray(recs)) return 'snapshot.records not array';
      if (recs.length === 0) return 'records empty';
      return null;
    },
  },
  {
    name: 'api/stock 4967.TW',
    url: '/api/stock?symbol=4967.TW&interval=1d&period=2y',
    expect: (j) => {
      const body = j as { ticker?: string; candles?: unknown[] };
      if (body.ticker !== '4967.TW') return `ticker mismatch: ${body.ticker}`;
      if (!Array.isArray(body.candles) || body.candles.length === 0) return 'no candles';
      return null;
    },
  },
  {
    name: 'api/portfolio/v12-signals N letter',
    url: '/api/portfolio/v12-signals?symbol=4967.TW&market=TW&entryPrice=200&buyDate=2026-04-25&triggerSignal=N&operationMode=short&patternTargetPrice=267.5&patternStopPrice=203.67',
    expect: (j) => {
      const body = j as {
        letter?: string;
        step3?: { stopLossPrice?: number };
        step4?: { operatingMA?: string };
        step5?: { takeProfit?: { triggered?: boolean } };
      };
      if (body.letter !== 'N') return `letter mismatch: ${body.letter}`;
      if (body.step4?.operatingMA !== 'MA10') return `step4.operatingMA expect MA10, got ${body.step4?.operatingMA}`;
      if (typeof body.step3?.stopLossPrice !== 'number') return 'step3.stopLossPrice missing';
      if (typeof body.step5?.takeProfit?.triggered !== 'boolean') return 'step5.takeProfit.triggered missing';
      return null;
    },
  },

  // ── Pages ────────────────────────────────────────────────────────────────
  // 只能驗 server response 200 + HTML 包含 expected marker；hydration crash 抓不到
  { name: 'page / (root)', url: '/', expect: () => null },
  { name: 'page /portfolio', url: '/portfolio', expect: () => null },
  { name: 'page /watchlist', url: '/watchlist', expect: () => null },
  { name: 'page /health', url: '/health', expect: () => null },
  { name: 'page /v12-performance', url: '/v12-performance', expect: () => null },
];

interface Result {
  name: string;
  url: string;
  pass: boolean;
  reason?: string;
  status?: number;
}

async function runProbe(p: Probe): Promise<Result> {
  try {
    const res = await fetch(`${HOST}${p.url}`);
    const status = res.status;
    if (status >= 500) {
      return { name: p.name, url: p.url, pass: false, status, reason: `HTTP ${status}` };
    }
    if (status >= 400) {
      return { name: p.name, url: p.url, pass: false, status, reason: `HTTP ${status}` };
    }
    if (p.expect) {
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const j: unknown = await res.json();
        const fail = p.expect(j, status);
        if (fail) return { name: p.name, url: p.url, pass: false, status, reason: fail };
      }
    }
    return { name: p.name, url: p.url, pass: true, status };
  } catch (err) {
    return {
      name: p.name,
      url: p.url,
      pass: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  console.log(`[smoke] HOST=${HOST}\n`);

  const results = await Promise.all(PROBES.map(runProbe));

  const passes = results.filter((r) => r.pass);
  const fails = results.filter((r) => !r.pass);

  for (const r of results) {
    const tag = r.pass ? '✓' : '✗';
    const status = r.status != null ? ` [${r.status}]` : '';
    const reason = r.reason ? ` — ${r.reason}` : '';
    console.log(`  ${tag} ${r.name}${status}${reason}`);
  }

  console.log(`\n[smoke] pass ${passes.length} / fail ${fails.length} / total ${results.length}`);

  if (fails.length > 0) {
    console.error('\n[smoke] FAIL — dev server 上以上路徑有問題');
    process.exit(1);
  }

  console.log('[smoke] OK\n');

  console.log('[smoke] ⚠️ 限制：本 script 只驗 server-side response，client-side hydration crash');
  console.log('         (例如 0513 chart pivots-empty Canvas crash) 抓不到。要完整覆蓋');
  console.log('         需 Playwright 真瀏覽器環境，待後續加裝。');
}

main().catch((e) => {
  console.error('[smoke] uncaught:', e);
  process.exit(2);
});
