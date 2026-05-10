/**
 * BackfillQueue — 缺棒補拉隊列
 *
 * 由 DownloadVerifier 偵測到 gap 後寫入，由 download-candles cron 開頭讀取並消費。
 *
 * 儲存位置：
 *   Vercel: Blob `queues/backfill-{market}.json`
 *   Local:  data/queues/backfill-{market}.json
 *
 * 語義：
 *   - 同一 symbol 多次加入會合併 ranges（以 symbol 為 key）
 *   - 每次嘗試消費後 attempts++；超過 MAX_ATTEMPTS 仍未補齊就放棄並告警
 *   - cron 消費成功的 symbol 從 queue 移除
 */

import type { CandleGap } from './validateCandles';

const IS_VERCEL = !!process.env.VERCEL;

export interface BackfillRange {
  /** YYYY-MM-DD — gap 前一根 K 棒的日期（不含） */
  from: string;
  /** YYYY-MM-DD — gap 後一根 K 棒的日期（不含） */
  to: string;
}

export interface BackfillItem {
  symbol: string;
  ranges: BackfillRange[];
  /** 第一次偵測到的時間 (ISO) */
  detectedAt: string;
  /** cron 嘗試消費的次數 */
  attempts: number;
  /** 最近一次 attempt 的時間 (ISO)，用於觀察補拉是否卡住 */
  lastAttemptAt?: string;
  /** 放棄補拉的 reason（attempts 超過門檻後設定） */
  abandonedReason?: string;
}

export interface BackfillQueue {
  market: 'TW' | 'CN';
  updatedAt: string;
  items: BackfillItem[];
}

/** 超過此嘗試次數仍未補齊 → 放棄，只 log，不再消費 */
export const MAX_ATTEMPTS = 5;

// ── Blob + local 存取 ──────────────────────────────────────────────────────────

function blobKey(market: 'TW' | 'CN'): string {
  return `queues/backfill-${market}.json`;
}

async function blobPut(key: string, data: string): Promise<void> {
  const { put } = await import('@vercel/blob');
  await put(key, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
}

async function blobGet(key: string): Promise<string | null> {
  const { get } = await import('@vercel/blob');
  const result = await get(key, { access: 'private' });
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

async function localPath(market: 'TW' | 'CN'): Promise<string> {
  const path = await import('path');
  return path.join(process.cwd(), 'data', 'queues', `backfill-${market}.json`);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function loadBackfillQueue(market: 'TW' | 'CN'): Promise<BackfillQueue> {
  const empty: BackfillQueue = { market, updatedAt: new Date().toISOString(), items: [] };
  try {
    let raw: string | null = null;
    if (IS_VERCEL) {
      raw = await blobGet(blobKey(market));
    } else {
      const { readFile } = await import('fs/promises');
      raw = await readFile(await localPath(market), 'utf-8');
    }
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as BackfillQueue;
    if (!parsed.items) return empty;
    return parsed;
  } catch {
    return empty;
  }
}

export async function saveBackfillQueue(queue: BackfillQueue): Promise<void> {
  const payload: BackfillQueue = {
    ...queue,
    updatedAt: new Date().toISOString(),
  };
  const json = JSON.stringify(payload);

  if (IS_VERCEL) {
    await blobPut(blobKey(queue.market), json);
  }

  // 也寫本地（開發 + Vercel warm instance）
  try {
    const { writeFile, mkdir } = await import('fs/promises');
    const { existsSync } = await import('fs');
    const path = await import('path');
    const dir = path.join(process.cwd(), 'data', 'queues');
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(await localPath(queue.market), json, 'utf-8');
  } catch { /* 只讀環境跳過 */ }
}

/**
 * 把偵測到的 gaps 合併進 queue。
 *
 * - 若 symbol 已在 queue：合併 ranges（去重），保留既有 attempts
 * - 若 symbol 不在：新增
 * - 返回合併後的 queue（caller 自行決定何時 save）
 */
export function mergeIntoQueue(
  queue: BackfillQueue,
  symbol: string,
  gaps: CandleGap[],
): BackfillQueue {
  if (gaps.length === 0) return queue;

  const newRanges: BackfillRange[] = gaps.map((g) => ({ from: g.fromDate, to: g.toDate }));
  const existing = queue.items.find((it) => it.symbol === symbol);

  if (existing) {
    // 合併 ranges，以 from+to 去重；保留既有 attempts/detectedAt
    const seen = new Set(existing.ranges.map((r) => `${r.from}_${r.to}`));
    for (const r of newRanges) {
      const k = `${r.from}_${r.to}`;
      if (!seen.has(k)) {
        existing.ranges.push(r);
        seen.add(k);
      }
    }
  } else {
    queue.items.push({
      symbol,
      ranges: newRanges,
      detectedAt: new Date().toISOString(),
      attempts: 0,
    });
  }
  return queue;
}

/**
 * 從 queue 移除 symbol（成功補齊後呼叫）。
 */
export function removeFromQueue(queue: BackfillQueue, symbol: string): BackfillQueue {
  queue.items = queue.items.filter((it) => it.symbol !== symbol);
  return queue;
}

/**
 * 標記一次消費嘗試（成功或失敗）。
 *
 * 失敗時 attempts++；若超過 MAX_ATTEMPTS，設 abandonedReason 並保留在 queue 供觀察，
 * 但 cron 會跳過放棄的項目。
 */
export function markAttempt(
  queue: BackfillQueue,
  symbol: string,
  reason?: string,
): BackfillQueue {
  const item = queue.items.find((it) => it.symbol === symbol);
  if (!item) return queue;
  item.attempts += 1;
  item.lastAttemptAt = new Date().toISOString();
  if (item.attempts >= MAX_ATTEMPTS && !item.abandonedReason) {
    item.abandonedReason = reason ?? `exceeded ${MAX_ATTEMPTS} attempts`;
  }
  return queue;
}
