/**
 * 清掉「Step 2 多頭軌 letter session 含 Step 1 池子外股票」的歷史 leak。
 *
 * 為什麼會有 leak：MarketScanner.scanBuyMethod 寫入 letter session 時用「當下池
 * 子」；之後池子被任何路徑（cron 重跑、手動 scan、回填）覆蓋後，凍結 session
 * 不會 retro-filter，造成 drift。
 *
 * 修法：對每個 BULLISH letter (B/C/E/J/K/L/M/P) session，用「目前池子」當 ground
 * truth 過濾掉非池內 results，重寫檔案/Blob。
 *
 * 防呆：
 *   - 池子不存在 → skip（無 ground truth）
 *   - 池子存在但空 → skip（abnormal state）
 *   - 反轉軌 (D/F/N/O) / 戰法軌 (Q) 不處理（書本設計：抓底不過 Step 1）
 *
 * Usage:
 *   # local data/ 目錄
 *   npx tsx scripts/cleanup-step1-leak.ts             # dry-run，只報告
 *   npx tsx scripts/cleanup-step1-leak.ts --apply     # 實際重寫檔案
 *
 *   # Production Blob（讀 .env.local 的 BLOB_READ_WRITE_TOKEN）
 *   VERCEL=1 npx tsx -r dotenv/config scripts/cleanup-step1-leak.ts --blob
 *   VERCEL=1 npx tsx -r dotenv/config scripts/cleanup-step1-leak.ts --blob --apply
 *
 *   # 只處理某市場
 *   ... --market TW
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { loadStep1Pool } from '../lib/scanner/step1Pool';
import type { MarketId } from '../lib/scanner/types';
import { BULLISH_TRACK_LETTERS as BULLISH_LETTERS } from '../lib/scanner/buyMethodTracks';
// post_close: scan-{market}-long-{letter}-{date}.json
const FILE_PATTERN_POST = /^scan-(TW|CN)-long-([BCEJKLMP])-(\d{4}-\d{2}-\d{2})\.json$/;
// intraday:   scan-{market}-long-{letter}-{date}-intraday-{HHMMSS}.json
// Intraday 檔名兩種格式並存（5/7 改 HHMM→HHMMSS 後新舊並存）
const FILE_PATTERN_INTRADAY = /^scan-(TW|CN)-long-([BCEJKLMP])-(\d{4}-\d{2}-\d{2})-intraday-(?:\d{4}|\d{6})\.json$/;

// ── Blob helpers（直接 raw I/O，繞過 loadScanSession 的 filter-on-read）────
async function blobList(prefix: string): Promise<Array<{ pathname: string }>> {
  const { list } = await import('@vercel/blob');
  const out: Array<{ pathname: string }> = [];
  let cursor: string | undefined;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    out.push(...r.blobs.map((b) => ({ pathname: b.pathname })));
    cursor = r.cursor;
  } while (cursor);
  return out;
}

async function blobGetRaw(pathname: string): Promise<string | null> {
  const { get } = await import('@vercel/blob');
  try {
    const result = await get(pathname, { access: 'private' });
    if (!result || !result.stream) return null;
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

async function blobPutRaw(pathname: string, data: string): Promise<void> {
  const { put } = await import('@vercel/blob');
  await put(pathname, data, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

interface CleanupReport {
  file: string;
  market: MarketId;
  letter: string;
  date: string;
  kind: 'post_close' | 'intraday';
  before: number;
  after: number;
  removed: string[];
}

// ── Step 1 池子日期預載：避免每個 session 各自打一次 blob/fs 找池子 ──
async function preloadPoolDates(useBlob: boolean, filterMarket?: MarketId): Promise<Set<string>> {
  const out = new Set<string>();
  const markets: MarketId[] = filterMarket ? [filterMarket] : ['TW', 'CN'];
  if (useBlob) {
    for (const market of markets) {
      const blobs = await blobList(`step1-pool/${market}/`);
      for (const b of blobs) {
        const m = b.pathname.match(/\/(\d{4}-\d{2}-\d{2})\.json$/);
        if (m) out.add(`${market}/${m[1]}`);
      }
    }
  } else {
    for (const market of markets) {
      const dir = path.join(process.cwd(), 'data', 'step1-pool', market);
      try {
        const files = await fs.readdir(dir);
        for (const f of files) {
          const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
          if (m) out.add(`${market}/${m[1]}`);
        }
      } catch { /* dir may not exist */ }
    }
  }
  return out;
}

interface SessionTarget {
  market: MarketId;
  letter: string;
  date: string;
  kind: 'post_close' | 'intraday';
  /** local: absolute fs path; blob: pathname */
  loc: string;
}

async function listLocalSessions(filterMarket?: MarketId): Promise<SessionTarget[]> {
  const dataDir = path.join(process.cwd(), 'data');
  const files = await fs.readdir(dataDir);
  const out: SessionTarget[] = [];
  for (const f of files) {
    const post = f.match(FILE_PATTERN_POST);
    const intra = f.match(FILE_PATTERN_INTRADAY);
    const m = post ?? intra;
    if (!m) continue;
    const market = m[1] as MarketId;
    if (filterMarket && market !== filterMarket) continue;
    out.push({
      market,
      letter: m[2],
      date: m[3],
      kind: post ? 'post_close' : 'intraday',
      loc: path.join(dataDir, f),
    });
  }
  return out;
}

async function listBlobSessions(filterMarket?: MarketId): Promise<SessionTarget[]> {
  const out: SessionTarget[] = [];
  const markets: MarketId[] = filterMarket ? [filterMarket] : ['TW', 'CN'];
  for (const market of markets) {
    for (const letter of BULLISH_LETTERS) {
      const prefix = `scans/${market}/long/${letter}/`;
      const blobs = await blobList(prefix);
      for (const b of blobs) {
        // post_close: scans/{market}/long/{letter}/{date}.json
        // intraday:   scans/{market}/long/{letter}/{date}/intraday/{HHMMSS}.json
        const intraMatch = b.pathname.match(/\/(\d{4}-\d{2}-\d{2})\/intraday\/(?:\d{4}|\d{6})\.json$/);
        if (intraMatch) {
          out.push({ market, letter, date: intraMatch[1], kind: 'intraday', loc: b.pathname });
          continue;
        }
        const postMatch = b.pathname.match(/\/(\d{4}-\d{2}-\d{2})\.json$/);
        if (postMatch) {
          out.push({ market, letter, date: postMatch[1], kind: 'post_close', loc: b.pathname });
        }
      }
    }
  }
  return out;
}

async function readSession(target: SessionTarget, useBlob: boolean): Promise<string | null> {
  if (useBlob) return blobGetRaw(target.loc);
  return fs.readFile(target.loc, 'utf-8').catch(() => null);
}

async function writeSession(target: SessionTarget, data: string, useBlob: boolean): Promise<void> {
  if (useBlob) return blobPutRaw(target.loc, data);
  await fs.writeFile(target.loc, data);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const useBlob = process.argv.includes('--blob');
  const marketArg = process.argv.find((a, i) => process.argv[i - 1] === '--market');
  const filterMarket = marketArg as MarketId | undefined;

  if (useBlob) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      console.error('--blob 模式需要 BLOB_READ_WRITE_TOKEN（請 source .env.local 或用 dotenv/config）');
      process.exit(1);
    }
    if (!process.env.VERCEL) {
      // step1Pool.ts / scanStorage.ts 用 process.env.VERCEL 切 Blob path
      process.env.VERCEL = '1';
    }
  }

  const targets = useBlob ? await listBlobSessions(filterMarket) : await listLocalSessions(filterMarket);

  console.log(`\n=== Step 1 leak retro-cleanup · ${useBlob ? 'BLOB' : 'LOCAL'} · ${apply ? 'APPLY' : 'DRY-RUN'} ===`);
  console.log(`Found ${targets.length} BULLISH letter sessions (post_close + intraday)${filterMarket ? ` (${filterMarket} only)` : ''}\n`);

  // ── 預載：哪些 (market, date) 有 Step 1 池子 → skip 掉沒池子的 session 不 read（省 blob 流量）──
  const poolDates = await preloadPoolDates(useBlob, filterMarket);
  const beforeCount = targets.length;
  const targetsWithPool = targets.filter((t) => poolDates.has(`${t.market}/${t.date}`));
  const noPoolSkip = beforeCount - targetsWithPool.length;
  console.log(`  Pre-skip (no pool): ${noPoolSkip} sessions — pool exists for ${poolDates.size} (market, date) pairs\n`);

  // ── 池子 cache：每個 (market, date) 只 load 一次 ──
  const poolCache = new Map<string, Set<string> | null>();
  async function getPool(market: MarketId, date: string): Promise<Set<string> | null> {
    const k = `${market}/${date}`;
    if (poolCache.has(k)) return poolCache.get(k)!;
    const p = await loadStep1Pool(market, date);
    const allowed = p && p.symbols.length > 0 ? new Set(p.symbols) : null;
    poolCache.set(k, allowed);
    return allowed;
  }

  // ── 並行讀（限制 concurrency 避免打爆 blob API）──
  const CONCURRENCY = useBlob ? 20 : 50;
  let scanned = 0;
  let skippedEmptyPool = 0;
  let cleanAlready = 0;
  const dirty: CleanupReport[] = [];
  let processed = 0;

  async function processOne(t: SessionTarget): Promise<void> {
    const raw = await readSession(t, useBlob);
    if (!raw) return;
    let session: { results?: Array<{ symbol: string }>; resultCount?: number };
    try {
      session = JSON.parse(raw);
    } catch {
      console.warn(`  [skip] ${t.loc} — JSON parse failed`);
      return;
    }
    scanned++;

    if (!session.results || session.results.length === 0) {
      cleanAlready++;
      return;
    }

    const allowed = await getPool(t.market, t.date);
    if (!allowed) {
      skippedEmptyPool++;
      return;
    }

    const before = session.results.length;
    const removed: string[] = [];
    const filtered = session.results.filter((r) => {
      const ok = allowed.has(r.symbol);
      if (!ok) removed.push(r.symbol);
      return ok;
    });

    if (removed.length === 0) {
      cleanAlready++;
      return;
    }

    dirty.push({ file: t.loc, market: t.market, letter: t.letter, date: t.date, kind: t.kind, before, after: filtered.length, removed });

    if (apply) {
      session.results = filtered;
      session.resultCount = filtered.length;
      await writeSession(t, JSON.stringify(session), useBlob);
    }
  }

  for (let i = 0; i < targetsWithPool.length; i += CONCURRENCY) {
    const batch = targetsWithPool.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(processOne));
    processed += batch.length;
    if (useBlob && processed % 200 === 0) {
      console.log(`  ... processed ${processed}/${targetsWithPool.length}, leak so far: ${dirty.length}`);
    }
  }

  console.log('\nSummary');
  console.log(`  Total found      : ${beforeCount}`);
  console.log(`  Pre-skip no pool : ${noPoolSkip}`);
  console.log(`  Scanned          : ${scanned}`);
  console.log(`  Already clean    : ${cleanAlready}`);
  console.log(`  Empty pool (skip): ${skippedEmptyPool}`);
  console.log(`  Has leak         : ${dirty.length}`);
  console.log(`  Total leak rows  : ${dirty.reduce((s, d) => s + d.removed.length, 0)}`);

  if (dirty.length > 0) {
    console.log('\nLeak detail:');
    for (const d of dirty) {
      const sample = d.removed.slice(0, 5).join(', ');
      const more = d.removed.length > 5 ? ` ... +${d.removed.length - 5}` : '';
      console.log(`  [${d.kind.padEnd(10)}] ${d.market} ${d.letter} ${d.date}  ${d.before} → ${d.after}  removed: ${sample}${more}`);
    }
    if (apply) {
      console.log(`\n✓ Rewrote ${dirty.length} ${useBlob ? 'blobs' : 'files'}.`);
    } else {
      console.log(`\n(dry-run) 加 --apply 才會實際重寫${useBlob ? 'Blob' : '檔案'}。`);
    }
  } else {
    console.log('\n✓ No leak found.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
