/**
 * LockWatch 鎖股觀察名單儲存層（v12 議題 61）
 *
 * 儲存路徑：`data/lock-watch/{market}/{date}.json`（local）
 *           `lock-watch/{market}/{date}.json`（Vercel Blob）
 *
 * 議題 61：每日合併寫入單檔，避免每股一檔造成 Blob 成本爆炸。
 *
 * 對應寫入時機：
 * - F V 反轉觸發 → createLockWatchFromF + saveLockWatchSnapshot
 * - N 型態確認觸發 → createLockWatchFromN + saveLockWatchSnapshot
 * - 每日盤後 → 讀前一日 snapshot → updateLockWatch (狀態演進) → 寫今日 snapshot
 */

import type { LockWatchDailySnapshot, LockWatchRecord } from '@/lib/scanner/lockWatchTypes';
import type { MarketId } from '@/lib/scanner/types';

const IS_VERCEL = !!process.env.VERCEL;

// ── Vercel Blob helpers ──────────────────────────────────────────────────────

async function blobPut(pathname: string, data: string): Promise<void> {
  const { blobPutWithRetry } = await import('@/lib/storage/blobRetry');
  await blobPutWithRetry(pathname, data, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

async function blobGet(pathname: string): Promise<string | null> {
  const { get } = await import('@vercel/blob');
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
}

async function blobListPrefix(prefix: string): Promise<Array<{ pathname: string; uploadedAt: Date }>> {
  const { list: blobList } = await import('@vercel/blob');
  const all: Array<{ pathname: string; uploadedAt: Date }> = [];
  let cursor: string | undefined;
  do {
    const result = await blobList({ prefix, limit: 100, cursor });
    all.push(...result.blobs.map((b) => ({ pathname: b.pathname, uploadedAt: b.uploadedAt })));
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return all;
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

async function fsPath(market: MarketId, date: string): Promise<string> {
  const path = await import('path');
  return path.join(process.cwd(), 'data', 'lock-watch', market, `${date}.json`);
}

async function fsPut(market: MarketId, date: string, data: string): Promise<void> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const { atomicFsPut } = await import('./atomicFsPut');
  const fullPath = await fsPath(market, date);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await atomicFsPut(fullPath, data);
}

async function fsGet(market: MarketId, date: string): Promise<string | null> {
  const { promises: fs } = await import('fs');
  try {
    const fullPath = await fsPath(market, date);
    return await fs.readFile(fullPath, 'utf-8');
  } catch {
    return null;
  }
}

async function fsListDates(market: MarketId): Promise<string[]> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const dir = path.join(process.cwd(), 'data', 'lock-watch', market);
  try {
    const files = await fs.readdir(dir);
    return files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace(/\.json$/, ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** 儲存指定日的鎖股觀察名單 snapshot */
export async function saveLockWatchSnapshot(snapshot: LockWatchDailySnapshot): Promise<void> {
  const data = JSON.stringify(snapshot);
  if (IS_VERCEL) {
    await blobPut(`lock-watch/${snapshot.market}/${snapshot.date}.json`, data);
  } else {
    await fsPut(snapshot.market, snapshot.date, data);
  }
}

/** 讀取指定日的鎖股觀察名單 snapshot；不存在回 null */
export async function loadLockWatchSnapshot(
  market: MarketId,
  date: string,
): Promise<LockWatchDailySnapshot | null> {
  const raw = IS_VERCEL
    ? await blobGet(`lock-watch/${market}/${date}.json`).catch(() => null)
    : await fsGet(market, date);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LockWatchDailySnapshot;
  } catch {
    return null;
  }
}

/** 列出某市場有資料的所有日期（最新在前）*/
export async function listLockWatchDates(market: MarketId): Promise<string[]> {
  if (IS_VERCEL) {
    const blobs = await blobListPrefix(`lock-watch/${market}/`);
    return blobs
      .map((b) => b.pathname.replace(`lock-watch/${market}/`, '').replace(/\.json$/, ''))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();
  }
  return fsListDates(market);
}

/** 取得某市場最新的觀察名單 snapshot */
export async function loadLatestLockWatchSnapshot(
  market: MarketId,
): Promise<LockWatchDailySnapshot | null> {
  const dates = await listLockWatchDates(market);
  for (const date of dates) {
    const snap = await loadLockWatchSnapshot(market, date);
    if (snap) return snap;
  }
  return null;
}

// inflight lock: 同一 (market, date) 的 read-merge-write 序列化
// 避免兩個並發 scan-bm（例如 F :00 + N :02）lose update：
//   T1 read → T2 read → T1 merge+write → T2 merge+write（T1 的 records 丟失）
// 改成第二個 caller 等第一個寫完再讀新版繼續 merge
// `withLockWatchLock` 也讓 cron evolve 共用同把鎖（避免 evolve 跟 scan-bm 並發
// 互蓋 today 的 records — 18:55 CN evolve 跟 18:44 CN scan-bm Q 11 min margin 太窄）
const appendInflight = new Map<string, Promise<LockWatchDailySnapshot>>();

/**
 * Cron `update-lockwatch` 用：序列化執行 read → evolve → merge → write，
 * 跟 `appendLockWatchRecords` 共用同一把 lock 避免 race
 *
 * 用法：傳入 callback，內部讀寫 lockwatch snapshot 都在鎖內串行執行。
 */
export async function withLockWatchLock<T>(
  market: MarketId,
  date: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = `${market}|${date}`;
  const previous = appendInflight.get(lockKey);
  const run = (previous ?? Promise.resolve()).then(fn);
  // 把 generic Promise 存進 Map（runtime 不依賴型別 — Map 只是用來序列化）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appendInflight.set(lockKey, run as Promise<any>);
  try {
    return await run;
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (appendInflight.get(lockKey) === (run as Promise<any>)) {
      appendInflight.delete(lockKey);
    }
  }
}

/** 合併新觸發紀錄到指定日的 snapshot（同 symbol 不重複觸發；以 newest 為主）*/
export async function appendLockWatchRecords(
  market: MarketId,
  date: string,
  newRecords: LockWatchRecord[],
): Promise<LockWatchDailySnapshot> {
  const lockKey = `${market}|${date}`;
  // 如果同 key 有正在跑的 append → 等它完成再起步（序列化）
  const previous = appendInflight.get(lockKey);
  const run = (previous ?? Promise.resolve()).then(async () => {
    const existing = await loadLockWatchSnapshot(market, date);
    const merged = new Map<string, LockWatchRecord>();
    if (existing) {
      for (const r of existing.records) merged.set(`${r.symbol}-${r.triggerSignal}`, r);
    }
    for (const r of newRecords) merged.set(`${r.symbol}-${r.triggerSignal}`, r);
    const snapshot: LockWatchDailySnapshot = {
      market,
      date,
      records: Array.from(merged.values()),
      lastUpdated: new Date().toISOString(),
    };
    await saveLockWatchSnapshot(snapshot);
    return snapshot;
  });
  appendInflight.set(lockKey, run);
  try {
    return await run;
  } finally {
    // 只有「現在還是這把 lock」時才刪除（其他 caller 可能已 chain 上去）
    if (appendInflight.get(lockKey) === run) {
      appendInflight.delete(lockKey);
    }
  }
}
