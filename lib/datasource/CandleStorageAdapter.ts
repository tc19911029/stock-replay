/**
 * CandleStorageAdapter — K 線儲存抽象層
 *
 * Production (Vercel): 使用 Vercel Blob 持久化
 * Local dev: 使用本地檔案系統 (data/candles/)
 *
 * 參照 lib/storage/scanStorage.ts 的 IS_VERCEL + Blob 模式
 */

import type { Candle } from '@/types';

const IS_VERCEL = !!process.env.VERCEL;

if (IS_VERCEL && !process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('[CandleStorage] BLOB_READ_WRITE_TOKEN 未設定，K 線 Blob 讀寫將失敗');
}

export interface CandleFileData {
  symbol: string;
  lastDate: string;
  updatedAt: string;
  candles: Candle[];
  /** 封存日期 — 收盤 cron 寫入時標記，表示此日期(含)之前的資料不可被盤中覆蓋 (Fundamental Rule R1) */
  sealedDate?: string;
}

// ── Vercel Blob helpers ──────────────────────────────────────────────────────

async function blobPut(pathname: string, data: string): Promise<void> {
  const { put } = await import('@vercel/blob');
  await put(pathname, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
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

// ── L1 in-memory cache (local dev only) ────────────────────────────────────────
import { getFromCache, updateCache, triggerPreload } from './L1CandleCache';

// ── Filesystem helpers ───────────────────────────────────────────────────────

import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const DATA_ROOT = path.join(process.cwd(), 'data', 'candles');

// 合法 symbol 格式：4-6 位數字 + 可選 .TW / .TWO / .SS / .SZ 後綴，或 ^TWII 等指數
// 拒絕包含 / \ .. 等 path-traversal 字元的 symbol，避免 user-supplied symbol
// 透過 watchlist/price-at 等 endpoint 讀取 DATA_ROOT 外的檔案。
const SYMBOL_RE = /^(?:\^[A-Za-z0-9]+|[A-Za-z0-9]{1,8}(?:\.[A-Za-z]{1,4})?)$/;

function assertSafeSymbol(symbol: string): void {
  if (!SYMBOL_RE.test(symbol)) {
    throw new Error(`invalid symbol format: ${JSON.stringify(symbol)}`);
  }
}

function localPath(symbol: string, market: 'TW' | 'CN'): string {
  assertSafeSymbol(symbol);
  return path.join(DATA_ROOT, market, `${symbol}.json`);
}

function blobKey(symbol: string, market: 'TW' | 'CN'): string {
  assertSafeSymbol(symbol);
  return `candles/${market}/${symbol}.json`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * 讀取 K 線原始 JSON
 */
export async function readCandleFile(
  symbol: string,
  market: 'TW' | 'CN',
): Promise<CandleFileData | null> {
  try {
    // ── L1 記憶體快取（本地開發專用）────────────────────────────────────────
    if (!IS_VERCEL) {
      const cached = getFromCache(symbol, market);
      if (cached) return cached;

      // Cache miss：觸發背景 bulk preload（冪等，第一次 miss 才會真正 spawn）
      triggerPreload(market);
    }

    let raw: string | null = null;

    if (IS_VERCEL) {
      raw = await blobGet(blobKey(symbol, market));
      // Fallback: 嘗試本地檔案（Vercel warm instance 可能有殘留）
      if (!raw) {
        try {
          raw = await readFile(localPath(symbol, market), 'utf-8');
        } catch { /* 沒有就算了 */ }
      }
    } else {
      raw = await readFile(localPath(symbol, market), 'utf-8');
    }

    if (!raw) return null;
    const data: CandleFileData = JSON.parse(raw);
    if (!data.candles || data.candles.length === 0) return null;
    // 清除 TWSE 除權息日標記（如 "2025-11-17*" → "2025-11-17"）
    for (const c of data.candles) {
      if (c.date.endsWith('*')) c.date = c.date.slice(0, -1);
    }
    if (data.lastDate.endsWith('*')) data.lastDate = data.lastDate.slice(0, -1);

    // 讀到後存入快取，下次直接命中
    if (!IS_VERCEL) updateCache(symbol, market, data);

    return data;
  } catch {
    return null;
  }
}

// Per-(symbol, market) 序列化 read-merge-write，避免並行 caller lose update。
// e.g. download-batch 對同一支同時跑 fast-path L2 注入 + 全量 API 下載：
//   A read existing(485) + merge X → write 486
//   B read existing(485) + merge Y → write 486（X 被 lose）
// 鎖把這兩個寫入接龍：A 完成後 B 再 read，看得到 X，最終 487 根都在。
const _writeInflight = new Map<string, Promise<void>>();

/**
 * 寫入 K 線原始 JSON（merge-safe + 並行序列化）
 *
 * 不直接覆蓋既有 L1，而是把新舊資料以 date 為 key 合併：
 *   - 同日 K 棒：新資料覆蓋舊（以 incoming 為權威）
 *   - 只在舊有的日期：保留（避免 provider 一次只回短期資料把歷史壓短）
 *
 * 這修復的問題：某支股票 L1 本來有 485 根，某次 download 只拉到 253 根
 * 會把 12/2024 ~ 2/2025 區段整段消失的 bug。
 */
export async function writeCandleFile(
  symbol: string,
  market: 'TW' | 'CN',
  candles: Candle[],
): Promise<void> {
  if (candles.length === 0) return;
  const key = `${market}:${symbol}`;
  const prev = _writeInflight.get(key);
  const next = (async () => {
    if (prev) {
      try { await prev; } catch { /* 前一個失敗不影響後續，新寫入仍要做 */ }
    }
    await _writeCandleFileImpl(symbol, market, candles);
  })();
  _writeInflight.set(key, next);
  try {
    await next;
  } finally {
    // 只有當鏈尾仍是自己時才清除（防止 race 把後續 caller 的 inflight 條目誤刪）
    if (_writeInflight.get(key) === next) _writeInflight.delete(key);
  }
}

async function _writeCandleFileImpl(
  symbol: string,
  market: 'TW' | 'CN',
  candles: Candle[],
): Promise<void> {
  const incoming: Candle[] = candles.map(c => ({
    date: c.date, open: c.open, high: c.high,
    low: c.low, close: c.close, volume: c.volume,
  }));

  // 讀既有 → merge
  const existing = await readCandleFile(symbol, market);
  let stripped: Candle[];
  if (existing && existing.candles.length > 0) {
    const map = new Map<string, Candle>();
    for (const c of existing.candles) map.set(c.date, c);
    for (const c of incoming) map.set(c.date, c); // incoming 覆蓋同日
    stripped = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  } else {
    stripped = incoming.sort((a, b) => a.date.localeCompare(b.date));
  }

  const lastDate = stripped[stripped.length - 1].date;
  const data: CandleFileData = {
    symbol,
    lastDate,
    updatedAt: new Date().toISOString(),
    candles: stripped,
    // 收盤 cron 寫入時自動封存（Fundamental Rule R1）
    sealedDate: lastDate,
  };

  const json = JSON.stringify(data);

  if (IS_VERCEL) {
    await blobPut(blobKey(symbol, market), json);
  }

  // 也嘗試寫本地（Vercel warm instance 可用；本地開發主要路徑）
  try {
    const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
    const dir = path.join(DATA_ROOT, market);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await atomicFsPut(localPath(symbol, market), json);
  } catch {
    // Vercel 部署目錄可能是只讀的，忽略
  }

  // 更新 L1 記憶體快取（本地開發），讓下次掃描立即拿到新資料
  if (!IS_VERCEL) updateCache(symbol, market, data);
}

/**
 * 檢查數據是否足夠新
 */
export async function checkCandleFreshness(
  symbol: string,
  market: 'TW' | 'CN',
  asOfDate: string,
): Promise<boolean> {
  const data = await readCandleFile(symbol, market);
  if (!data) return false;
  return data.lastDate >= asOfDate;
}
