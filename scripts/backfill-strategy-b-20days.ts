/**
 * Backfill 策略 B（回後買上漲）過去 20 個交易日
 *
 * 背景：commit af190d0 放寬「站回 MA5 → 放量突破」時序至跨日 N≤3
 * （RECLAIM_LOOKBACK = 2）。需要把過去 20 個交易日的 ScanSession 用
 * 新版 detector 重跑覆寫，避免前端讀到舊 B 命中結果。
 *
 * 用法：
 *   1. dev server 必須在 :3000 跑（npm run dev）
 *   2. npx tsx scripts/backfill-strategy-b-20days.ts
 *
 * 範圍：自動掃 `data/scan-{TW|CN}-long-daily-YYYY-MM-DD-*.json` 取最新 20 個 session 日期，
 *   TW + CN 各 20 天 = 40 任務。force=1 觸發完整重算（含 B detector 最新版）。
 * 寫入：本地 `data/`（IS_VERCEL=false），不動 Blob。
 * 預估：~30s/任務 × 40 ≈ 20 分鐘。
 */
import { promises as fs } from 'fs';
import path from 'path';

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const PAST_TRADING_DAYS = 20;

async function readSecret(): Promise<string> {
  const envPath = path.resolve(__dirname, '..', '.env.local');
  const text = await fs.readFile(envPath, 'utf-8');
  const m = text.match(/^CRON_SECRET=(.+)$/m);
  if (!m) throw new Error('CRON_SECRET not found in .env.local');
  return m[1].trim().replace(/^["'](.*)["']$/, '$1');
}

async function listLatestDates(market: 'TW' | 'CN', limit: number): Promise<string[]> {
  const entries = await fs.readdir(DATA_DIR);
  const re = new RegExp(`^scan-${market}-long-daily-(\\d{4}-\\d{2}-\\d{2})`);
  const set = new Set<string>();
  for (const f of entries) {
    const m = f.match(re);
    if (m) set.add(m[1]);
  }
  return [...set].sort().slice(-limit);
}

interface CallResult {
  ok: boolean;
  detail: string;
  ms: number;
  resultCount?: number;
}

async function callScan(market: 'TW' | 'CN', date: string, secret: string): Promise<CallResult> {
  const url = `${BASE_URL}/api/cron/scan-${market.toLowerCase()}?date=${date}&force=1`;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 240_000);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` }, signal: ctrl.signal });
    const body = await res.text();
    const ms = Date.now() - t0;
    let ok = res.ok;
    let detail = '';
    let resultCount: number | undefined;
    try {
      const j = JSON.parse(body) as { ok?: boolean; resultCount?: number; error?: string; skipped?: boolean; reason?: string };
      if (j.skipped) { ok = true; detail = `skipped (${j.reason ?? 'unknown'})`; }
      else if (j.ok === false || j.error) { ok = false; detail = j.error ?? 'failed'; }
      else if (typeof j.resultCount === 'number') { detail = `n=${j.resultCount}`; resultCount = j.resultCount; }
      else { detail = 'ok'; }
    } catch { if (!ok) detail = body.slice(0, 100); }
    return { ok, detail, ms, resultCount };
  } catch (err) {
    return { ok: false, detail: String(err), ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

async function main(): Promise<void> {
  const secret = await readSecret();
  const twDates = await listLatestDates('TW', PAST_TRADING_DAYS);
  const cnDates = await listLatestDates('CN', PAST_TRADING_DAYS);

  if (twDates.length < PAST_TRADING_DAYS) {
    console.warn(`⚠ TW 只找到 ${twDates.length} 天 session（< ${PAST_TRADING_DAYS}），會全部跑`);
  }
  if (cnDates.length < PAST_TRADING_DAYS) {
    console.warn(`⚠ CN 只找到 ${cnDates.length} 天 session（< ${PAST_TRADING_DAYS}），會全部跑`);
  }

  const tasks: Array<{ market: 'TW' | 'CN'; date: string }> = [];
  for (const d of twDates) tasks.push({ market: 'TW', date: d });
  for (const d of cnDates) tasks.push({ market: 'CN', date: d });

  console.log(`\nB 策略 backfill 啟動：TW ${twDates.length} 天 + CN ${cnDates.length} 天 = ${tasks.length} 任務`);
  console.log(`TW 範圍：${twDates[0]} → ${twDates[twDates.length - 1]}`);
  console.log(`CN 範圍：${cnDates[0]} → ${cnDates[cnDates.length - 1]}\n`);

  let okCount = 0;
  let failCount = 0;
  const failures: Array<{ market: string; date: string; detail: string }> = [];

  for (let i = 0; i < tasks.length; i++) {
    const { market, date } = tasks[i];
    process.stdout.write(`[${i + 1}/${tasks.length}] ${market} ${date} ... `);
    const r = await callScan(market, date, secret);
    if (r.ok) {
      okCount++;
      console.log(`✓ ${r.detail} (${(r.ms / 1000).toFixed(1)}s)`);
    } else {
      failCount++;
      failures.push({ market, date, detail: r.detail });
      console.log(`✗ ${r.detail} (${(r.ms / 1000).toFixed(1)}s)`);
    }
    // TW 之間 sleep 15s — 避開 TWSE/ISIN 速率限制（前一輪 04-27~05-08 連跑撞 stocklist 安全閘）
    // CN 不需要 sleep（東財 API 寬鬆），且最後一筆也不 sleep
    const next = tasks[i + 1];
    if (next && market === 'TW' && next.market === 'TW') {
      await new Promise(r => setTimeout(r, 15_000));
    }
  }

  console.log(`\n========== 完成 ==========`);
  console.log(`OK: ${okCount}/${tasks.length}, FAIL: ${failCount}`);
  if (failures.length > 0) {
    console.log(`\n失敗清單：`);
    for (const f of failures) console.log(`  ${f.market} ${f.date}: ${f.detail}`);
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
