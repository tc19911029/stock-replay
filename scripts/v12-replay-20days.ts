/**
 * v12 全面歷史回放 — 過去 N 個交易日 × TW+CN × 16 個 buy methods + daily-A
 *
 * 透過本地 dev server 的 cron 端點觸發 scan，產出 L4 session 寫入 data/scan-*.json
 * 後續用 sync-replayed-scans-to-blob.ts 推上 Vercel Blob，production 即可看到。
 *
 * 用法：
 *   npx tsx scripts/v12-replay-20days.ts [--days 20] [--markets TW,CN] [--start-from 2026-04-10]
 *
 * 預估時間：20 天 × 2 市場 × 17 scan = 680 invocations × ~30s = ~5.5 小時
 */

import { isTradingDay } from '../lib/utils/tradingDay';

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

const ALL_METHODS = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'] as const;

interface RunResult {
  market: 'TW' | 'CN';
  date: string;
  endpoint: string;
  ok: boolean;
  detail?: string;
  ms: number;
}

async function fetchWithTimeout(url: string, timeoutMs = 240_000): Promise<{ ok: boolean; body: string; status: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const body = await res.text();
    return { ok: res.ok, body, status: res.status };
  } catch (err) {
    return { ok: false, body: String(err), status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function callScan(market: 'TW' | 'CN', date: string, endpoint: string): Promise<RunResult> {
  const url = `${BASE_URL}${endpoint}`;
  const t0 = Date.now();
  const r = await fetchWithTimeout(url);
  const ms = Date.now() - t0;
  let ok = r.ok;
  let detail = '';
  try {
    const j = JSON.parse(r.body) as { ok?: boolean; resultCount?: number; counts?: Record<string, number>; error?: string };
    if (j.ok === false || j.error) {
      ok = false;
      detail = j.error ?? 'failed';
    } else if (typeof j.resultCount === 'number') {
      detail = `n=${j.resultCount}`;
    } else if (j.counts) {
      detail = Object.entries(j.counts).map(([k, v]) => `${k.split('-').pop()}=${v}`).join(',');
    }
  } catch {
    if (!ok) detail = r.body.slice(0, 100);
  }
  return { market, date, endpoint, ok, detail, ms };
}

function getLastNTradingDays(n: number, startFrom?: string): string[] {
  const start = startFrom ? new Date(startFrom) : new Date();
  const out: string[] = [];
  const d = new Date(start);
  while (out.length < n) {
    const iso = d.toISOString().slice(0, 10);
    if (isTradingDay(iso, 'TW') || isTradingDay(iso, 'CN')) {
      out.push(iso);
    }
    d.setDate(d.getDate() - 1);
    if (d.getFullYear() < 2024) break;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const argVal = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const days = parseInt(argVal('--days') ?? '20', 10);
  const marketsArg = argVal('--markets') ?? 'TW,CN';
  const startFrom = argVal('--start-from');
  const skipMain = args.includes('--no-main');
  const skipBm = args.includes('--no-bm');

  const markets = marketsArg.split(',').map((s) => s.trim().toUpperCase()).filter((m) => m === 'TW' || m === 'CN') as ('TW' | 'CN')[];
  const dates = getLastNTradingDays(days, startFrom);

  console.log(`v12 replay 啟動：${days} 個交易日 × ${markets.join(',')} × ${ALL_METHODS.length + 1} scans`);
  console.log(`日期範圍：${dates[dates.length - 1]} → ${dates[0]} (${dates.length} 天)`);
  console.log(`預估：${dates.length * markets.length * (ALL_METHODS.length + 1)} 次 fetch\n`);

  const allResults: RunResult[] = [];
  let totalDone = 0;
  const totalPlan = dates.length * markets.length * ((skipMain ? 0 : 1) + (skipBm ? 0 : ALL_METHODS.length));

  for (const date of dates) {
    for (const market of markets) {
      // 非交易日跳過
      if (!isTradingDay(date, market)) {
        console.log(`  ${date} ${market}：非交易日，跳過`);
        continue;
      }

      // 1. main scan (daily A)
      if (!skipMain) {
        const ep = market === 'TW' ? `/api/cron/scan-tw?date=${date}` : `/api/cron/scan-cn?date=${date}`;
        const r = await callScan(market, date, ep);
        allResults.push(r);
        totalDone++;
        console.log(`  [${totalDone}/${totalPlan}] ${date} ${market} A    ${r.ok ? '✓' : '✗'} ${r.detail} (${r.ms}ms)`);
      }

      // 2. buy methods B-Q
      if (!skipBm) {
        for (const method of ALL_METHODS) {
          const ep = `/api/cron/scan-bm?market=${market}&method=${method}&date=${date}`;
          const r = await callScan(market, date, ep);
          allResults.push(r);
          totalDone++;
          console.log(`  [${totalDone}/${totalPlan}] ${date} ${market} ${method.padEnd(2)}   ${r.ok ? '✓' : '✗'} ${r.detail} (${r.ms}ms)`);
        }
      }
    }
  }

  // ── 摘要 ──
  const ok = allResults.filter((r) => r.ok).length;
  const fail = allResults.filter((r) => !r.ok).length;
  const totalMs = allResults.reduce((sum, r) => sum + r.ms, 0);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`完成：${ok} ok / ${fail} fail / 總時 ${(totalMs / 1000 / 60).toFixed(1)} 分`);
  if (fail > 0) {
    console.log(`\n失敗清單：`);
    for (const r of allResults.filter((x) => !x.ok)) {
      console.log(`  ${r.date} ${r.market} ${r.endpoint}: ${r.detail}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
