/**
 * Step 1 預選池 cache
 *
 * 概念：每天 14:02 跑 A 六條件 + 戒律 + 淘汰法 → 寫今日「合格股票池」cache。
 * 14:10 多頭軌 8 個 detector（B/C/E/J/K/L/M/P）讀今日 cache 當候選來源。
 *
 * 設計原則（書本五步法 Step 1 → Step 2）：
 * - cache key 含日期，保證「今日的池子今日用」(用戶要求)
 * - 過了今天的池子明天會重新算，不沿用（避免昨天合格今天不合格的污染）
 *
 * 反轉軌（D/F/N/O）+ 戰法軌（Q）不過 Step 1，全市場掃描 — 不用這個 cache。
 *
 * 儲存路徑：
 *  - local: data/step1-pool/{market}/{date}.json
 *  - vercel: step1-pool/{market}/{date}.json (Blob)
 */

import type { MarketId } from './types';

const IS_VERCEL = !!process.env.VERCEL;

export interface Step1Pool {
  market: MarketId;
  date: string;        // YYYY-MM-DD（生成時的 asOfDate）
  symbols: string[];   // 過 A 六條件 + 戒律 + 淘汰法 的股票代號清單
  generatedAt: string; // ISO timestamp
  /** 各層過濾後人數（除錯+UI 顯示）*/
  stats: {
    total: number;        // 總候選數
    passSixCond: number;  // 過六條件
    passProhib: number;   // 過戒律
    passElim: number;     // 過淘汰法 = 最終池子大小
  };
}

// ── Vercel Blob helpers ─────────────────────────────────────────

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

// ── Filesystem helpers ──────────────────────────────────────────

async function fsPath(market: MarketId, date: string): Promise<string> {
  const path = await import('path');
  return path.join(process.cwd(), 'data', 'step1-pool', market, `${date}.json`);
}

async function fsPut(market: MarketId, date: string, data: string): Promise<void> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  const fullPath = await fsPath(market, date);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await atomicFsPut(fullPath, data);
}

async function fsGet(market: MarketId, date: string): Promise<string | null> {
  const { promises: fs } = await import('fs');
  try {
    return await fs.readFile(await fsPath(market, date), 'utf-8');
  } catch {
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────

/** 寫入指定日的 Step 1 池子 cache */
export async function saveStep1Pool(pool: Step1Pool): Promise<void> {
  const data = JSON.stringify(pool);
  if (IS_VERCEL) {
    await blobPut(`step1-pool/${pool.market}/${pool.date}.json`, data);
  } else {
    await fsPut(pool.market, pool.date, data);
  }
}

/** 讀取指定日的 Step 1 池子 cache；不存在或過期回 null */
export async function loadStep1Pool(
  market: MarketId,
  date: string,
): Promise<Step1Pool | null> {
  const raw = IS_VERCEL
    ? await blobGet(`step1-pool/${market}/${date}.json`)
    : await fsGet(market, date);
  if (!raw) return null;
  try {
    const pool = JSON.parse(raw) as Step1Pool;
    if (pool.date !== date || pool.market !== market) {
      console.warn(`[step1Pool] cache key mismatch: requested ${market}/${date}, got ${pool.market}/${pool.date}`);
      return null;
    }
    return pool;
  } catch {
    return null;
  }
}

/**
 * 多頭軌 detector 用：取得今日合格 symbols（Set 格式方便 O(1) lookup）
 * 池子不存在時回 null（caller 應 fallback 到全市場 + 警示池子未準備）
 */
export async function getStep1Symbols(
  market: MarketId,
  date: string,
): Promise<Set<string> | null> {
  const pool = await loadStep1Pool(market, date);
  if (!pool) return null;
  return new Set(pool.symbols);
}
