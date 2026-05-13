/**
 * Backfill 反轉軌 + 戰法軌（D/F/N/O/Q）過去 20 個交易日的戒律標記
 *
 * 背景：2026-05-11 MarketScanner.scanBuyMethod 新增 longProhibitionsReasons
 * 寫入到 ScanResult，但只有 5/8 重跑過。歷史日期回看時，反轉軌訊號（含戒律
 * 觸發的）UI 沒灰化。Backfill 過去 20 個交易日重寫 session 補上欄位。
 *
 * 用法：
 *   npm run dev  # 在 :3000
 *   npx tsx scripts/backfill-prohibition-history.ts
 *
 * 0513 ABCDE E：從 scan-bm（一字母一 call）改 scan-bm-batch（一 track 一 call），
 * 同 track 內字母共用 stockList / L2 / TurnoverRank — 比舊版省 ~5 倍時間。
 * 反轉軌(D/F/N/O) + 戰法軌(Q) = 2 個 track × 20 天 × 2 市場 = 80 call（舊版 200）。
 *
 * 注意：scan-bm-batch 用 force=1 也會覆寫 ScanSession。
 *      不影響 LockWatch（appendLockWatchRecords 內 dedup by symbol+date+signal）
 */
import { promises as fs } from 'fs';
import path from 'path';

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;
const DATA_DIR = path.resolve(__dirname, '..', 'data');
// 反轉軌 + 戰法軌（不過 Step 1 的字母）— 對應 scan-bm-batch 的 reversal/system track
const TRACKS = ['reversal', 'system'] as const;
const PAST_DAYS = 20;
const TW_SLEEP_MS = 8_000;

async function readSecret(): Promise<string> {
  const envPath = path.resolve(__dirname, '..', '.env.local');
  const text = await fs.readFile(envPath, 'utf-8');
  const m = text.match(/^CRON_SECRET=(.+)$/m);
  if (!m) throw new Error('CRON_SECRET not found in .env.local');
  return m[1].trim().replace(/^["'](.*)["']$/, '$1');
}

async function listLatestDates(market: 'TW' | 'CN', limit: number): Promise<string[]> {
  const entries = await fs.readdir(DATA_DIR);
  // 任一 method session 都行，用 N 比較全
  const re = new RegExp(`^scan-${market}-long-N-(\\d{4}-\\d{2}-\\d{2})`);
  const set = new Set<string>();
  for (const f of entries) {
    const m = f.match(re);
    if (m) set.add(m[1]);
  }
  return [...set].sort().slice(-limit);
}

async function callScanBatch(
  market: 'TW' | 'CN',
  track: typeof TRACKS[number],
  date: string,
  secret: string,
) {
  const url = `${BASE_URL}/api/cron/scan-bm-batch?market=${market}&track=${track}&date=${date}&force=1`;
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
      const j = JSON.parse(body) as {
        ok?: boolean;
        data?: { skipped?: boolean; reason?: string; results?: Record<string, { resultCount?: number }> };
        error?: string;
      };
      const d = j.data ?? {};
      if (d.skipped) { ok = true; detail = `skipped (${d.reason ?? '?'})`; }
      else if (j.ok === false || j.error) { ok = false; detail = j.error ?? 'failed'; }
      else if (d.results) {
        const parts = Object.entries(d.results).map(([m, r]) => `${m}=${r.resultCount ?? '?'}`);
        detail = parts.join(' ');
      }
    } catch { if (!ok) detail = body.slice(0, 80); }
    return { ok, detail, ms };
  } catch (err) {
    return { ok: false, detail: String(err), ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

async function main(): Promise<void> {
  const secret = await readSecret();
  const twDates = await listLatestDates('TW', PAST_DAYS);
  const cnDates = await listLatestDates('CN', PAST_DAYS);

  console.log(`Backfill 戒律標記啟動：`);
  console.log(`  TW ${twDates.length} 天 (${twDates[0]} → ${twDates.at(-1)})`);
  console.log(`  CN ${cnDates.length} 天 (${cnDates[0]} → ${cnDates.at(-1)})`);
  console.log(`  Tracks: ${TRACKS.join(', ')}`);
  console.log(`  Total: ${(twDates.length + cnDates.length) * TRACKS.length} cron call\n`);

  let ok = 0, fail = 0;
  const failures: Array<{ key: string; detail: string }> = [];

  const tasks: Array<{ market: 'TW' | 'CN'; date: string; track: typeof TRACKS[number] }> = [];
  for (const d of twDates) for (const t of TRACKS) tasks.push({ market: 'TW', date: d, track: t });
  for (const d of cnDates) for (const t of TRACKS) tasks.push({ market: 'CN', date: d, track: t });

  for (let i = 0; i < tasks.length; i++) {
    const { market, date, track } = tasks[i];
    process.stdout.write(`[${i + 1}/${tasks.length}] ${market} ${track} ${date} ... `);
    const r = await callScanBatch(market, track, date, secret);
    if (r.ok) {
      ok++;
      console.log(`✓ ${r.detail} (${(r.ms / 1000).toFixed(1)}s)`);
    } else {
      fail++;
      failures.push({ key: `${market}-${track}-${date}`, detail: r.detail });
      console.log(`✗ ${r.detail} (${(r.ms / 1000).toFixed(1)}s)`);
    }
    // TW 之間 sleep 避免 stocklist 速率限制；CN 不 sleep
    const next = tasks[i + 1];
    if (next && market === 'TW' && next.market === 'TW') {
      await new Promise(r => setTimeout(r, TW_SLEEP_MS));
    }
  }

  console.log(`\n========== 完成 ==========`);
  console.log(`OK: ${ok}/${tasks.length}, FAIL: ${fail}`);
  if (failures.length > 0) {
    console.log(`\n失敗清單：`);
    for (const f of failures.slice(0, 30)) console.log(`  ${f.key}: ${f.detail}`);
    if (failures.length > 30) console.log(`  ... ${failures.length - 30} more`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
