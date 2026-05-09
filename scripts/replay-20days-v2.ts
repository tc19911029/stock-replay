/**
 * Replay 過去 N 個交易日 — 用新的 4-endpoint batch 架構
 *
 * 對應 PR #35-#41 之後的新邏輯：
 *   1. scan-tw/cn → A 預選池（寫 step1-pool cache + scan session）
 *   2. scan-bm-batch?track=bullish → B/C/E/J/K/L/M/P 8 個多頭軌（讀 step1-pool）
 *   3. scan-bm-batch?track=reversal → D/F/N/O 4 個反轉軌（全市場）
 *   4. scan-bm-batch?track=system  → Q 戰法軌（全市場 + 戒律）
 *
 * 順序保證：A 先跑完寫池子，後續 batch 才能讀。
 *
 * 用法：
 *   1. 起本地 dev server: `npm run dev`（自動讀 .env.local 含 BLOB_READ_WRITE_TOKEN）
 *   2. `npx tsx scripts/replay-20days-v2.ts [--days 20] [--markets TW,CN] [--start-from 2026-05-08]`
 *   3. 完成後 `npx tsx scripts/sync-replayed-scans-to-blob.ts` 推到 Blob
 *
 * 預估：20 天 × 2 市場 × 4 endpoint = 160 calls × ~30s = ~80 min
 */

import { isTradingDay } from '../lib/utils/tradingDay';

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

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

async function callEndpoint(market: 'TW' | 'CN', date: string, label: string, endpoint: string): Promise<RunResult> {
  const url = `${BASE_URL}${endpoint}`;
  const t0 = Date.now();
  const r = await fetchWithTimeout(url);
  const ms = Date.now() - t0;
  let ok = r.ok;
  let detail = '';
  try {
    const j = JSON.parse(r.body) as {
      ok?: boolean; resultCount?: number; error?: string;
      summary?: Record<string, { count: number }>;
      results?: unknown[]; total?: number;
    };
    if (j.ok === false || j.error) {
      ok = false;
      detail = j.error ?? 'failed';
    } else if (j.summary) {
      // batch endpoint 回 summary
      detail = Object.entries(j.summary).map(([k, v]) => `${k}=${v.count}`).join(' ');
    } else if (typeof j.resultCount === 'number') {
      detail = `n=${j.resultCount}`;
    } else if (typeof j.total === 'number') {
      detail = `n=${j.total}`;
    }
  } catch {
    if (!ok) detail = r.body.slice(0, 100);
  }
  return { market, date, endpoint: label, ok, detail, ms };
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

  const markets = marketsArg.split(',').map((s) => s.trim().toUpperCase()).filter((m) => m === 'TW' || m === 'CN') as ('TW' | 'CN')[];
  const dates = getLastNTradingDays(days, startFrom);

  console.log(`v12 replay v2 啟動：${days} 個交易日 × ${markets.join(',')} × 4 endpoint`);
  console.log(`日期範圍：${dates[dates.length - 1]} → ${dates[0]} (${dates.length} 天)`);
  console.log(`預估：${dates.length * markets.length * 4} 次 fetch\n`);

  const allResults: RunResult[] = [];
  let totalDone = 0;
  const totalPlan = dates.length * markets.length * 4;

  for (const date of dates) {
    for (const market of markets) {
      if (!isTradingDay(date, market)) {
        console.log(`  ${date} ${market}：非交易日，跳過`);
        continue;
      }

      // 1. A 預選池 — 寫 step1-pool cache + 寫 scan session（force=1 強制重寫，
      //    確保新代碼的 step1-pool cache 寫入；不用 force 會 dedup 跳過 → step1-pool 永遠不會更新）
      const aEndpoint = market === 'TW' ? `/api/cron/scan-tw?date=${date}&force=1` : `/api/cron/scan-cn?date=${date}&force=1`;
      const rA = await callEndpoint(market, date, 'A', aEndpoint);
      allResults.push(rA);
      totalDone++;
      console.log(`  [${totalDone}/${totalPlan}] ${date} ${market} A 預選池      ${rA.ok ? '✓' : '✗'} ${rA.detail} (${rA.ms}ms)`);

      // ⚠️ 必須等 A 完成才能跑 bullish track（讀 step1-pool）
      // 2. Step 2 多頭軌 — 8 個 detector 從 step1-pool 池子挑
      const rBull = await callEndpoint(market, date, 'bullish', `/api/cron/scan-bm-batch?market=${market}&track=bullish&date=${date}`);
      allResults.push(rBull);
      totalDone++;
      console.log(`  [${totalDone}/${totalPlan}] ${date} ${market} bullish 多頭   ${rBull.ok ? '✓' : '✗'} ${rBull.detail} (${rBull.ms}ms)`);

      // 3. 反轉軌 — 4 個 detector 全市場掃
      const rRev = await callEndpoint(market, date, 'reversal', `/api/cron/scan-bm-batch?market=${market}&track=reversal&date=${date}`);
      allResults.push(rRev);
      totalDone++;
      console.log(`  [${totalDone}/${totalPlan}] ${date} ${market} reversal 反轉  ${rRev.ok ? '✓' : '✗'} ${rRev.detail} (${rRev.ms}ms)`);

      // 4. 戰法軌 — Q 全市場 + 戒律
      const rSys = await callEndpoint(market, date, 'system', `/api/cron/scan-bm-batch?market=${market}&track=system&date=${date}`);
      allResults.push(rSys);
      totalDone++;
      console.log(`  [${totalDone}/${totalPlan}] ${date} ${market} system 戰法    ${rSys.ok ? '✓' : '✗'} ${rSys.detail} (${rSys.ms}ms)`);
    }
  }

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
