/**
 * Backfill daily session matchedMethods 缺漏 M/N/O/P/Q
 *
 * 背景：MarketScanner.ts:529-561 daily writer 之前只跑 A-I detector，
 * 沒跑 v12 後補字母 M/N/O/P/Q → 池內股票徽章不全。0510 已修 writer，
 * 此 script 把過去 N 天 daily session 重跑，讓舊資料也有 M-Q。
 *
 * 用法：
 *   1. dev server 必須在 :3000 跑（npm run dev）
 *   2. npx tsx scripts/backfill-daily-matched-methods.ts
 *
 * 範圍：自動掃 `data/scan-{TW|CN}-long-daily-YYYY-MM-DD-*.json` 取得歷史日期清單
 * 寫入：本地 `data/`（IS_VERCEL=false），不動 Blob
 * 預估：22+23 ≈ 45 個 (market, date) × ~30s ≈ 22 min
 */
import { promises as fs } from 'fs';
import path from 'path';

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;
const DATA_DIR = path.resolve(__dirname, '..', 'data');

async function readSecret(): Promise<string> {
  const envPath = path.resolve(__dirname, '..', '.env.local');
  const text = await fs.readFile(envPath, 'utf-8');
  const m = text.match(/^CRON_SECRET=(.+)$/m);
  if (!m) throw new Error('CRON_SECRET not found in .env.local');
  // 剝掉雙/單引號（dotenv 風格）
  return m[1].trim().replace(/^["'](.*)["']$/, '$1');
}

async function listDates(market: 'TW' | 'CN'): Promise<string[]> {
  const entries = await fs.readdir(DATA_DIR);
  const re = new RegExp(`^scan-${market}-long-daily-(\\d{4}-\\d{2}-\\d{2})`);
  const set = new Set<string>();
  for (const f of entries) {
    const m = f.match(re);
    if (m) set.add(m[1]);
  }
  return [...set].sort();
}

async function callScan(market: 'TW' | 'CN', date: string, secret: string): Promise<{ ok: boolean; detail: string; ms: number }> {
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
    try {
      const j = JSON.parse(body) as { ok?: boolean; resultCount?: number; error?: string; skipped?: boolean; reason?: string };
      if (j.skipped) { ok = true; detail = `skipped (${j.reason})`; }
      else if (j.ok === false || j.error) { ok = false; detail = j.error ?? 'failed'; }
      else if (typeof j.resultCount === 'number') { detail = `n=${j.resultCount}`; }
      else { detail = 'ok'; }
    } catch { if (!ok) detail = body.slice(0, 100); }
    return { ok, detail, ms };
  } catch (err) {
    return { ok: false, detail: String(err), ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

async function main() {
  const secret = await readSecret();
  const twDates = await listDates('TW');
  const cnDates = await listDates('CN');
  const tasks: Array<{ market: 'TW' | 'CN'; date: string }> = [];
  for (const d of twDates) tasks.push({ market: 'TW', date: d });
  for (const d of cnDates) tasks.push({ market: 'CN', date: d });

  console.log(`Backfill 啟動：TW ${twDates.length} 天 + CN ${cnDates.length} 天 = ${tasks.length} 個 (market, date)`);
  console.log(`日期範圍 TW: ${twDates[0]} → ${twDates[twDates.length - 1]}`);
  console.log(`日期範圍 CN: ${cnDates[0]} → ${cnDates[cnDates.length - 1]}`);
  console.log('');

  let ok = 0, fail = 0;
  const fails: Array<{ market: string; date: string; detail: string }> = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const r = await callScan(t.market, t.date, secret);
    if (r.ok) ok++; else { fail++; fails.push({ ...t, detail: r.detail }); }
    console.log(`[${i + 1}/${tasks.length}] ${t.market} ${t.date}  ${r.ok ? '✓' : '✗'}  ${r.detail}  (${r.ms}ms)`);
  }

  console.log('');
  console.log(`完成：${ok} ok / ${fail} fail`);
  if (fails.length) {
    console.log('\n失敗清單：');
    for (const f of fails) console.log(`  ${f.market} ${f.date}: ${f.detail}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
