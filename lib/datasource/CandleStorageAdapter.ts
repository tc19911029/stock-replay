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

interface CandleFileData {
  symbol: string;
  lastDate: string;
  updatedAt: string;
  candles: Candle[];
}

// ── Vercel Blob helpers ──────────────────────────────────────────────────────

async function blobPut(pathname: string, data: string): Promise<void> {
  const { put } = await import('@vercel/blob');
  await put(pathname, data, { access: 'public', addRandomSuffix: false });
}

async function blobGet(pathname: string): Promise<string | null> {
  const { list: blobList } = await import('@vercel/blob');
  const { blobs } = await blobList({ prefix: pathname, limit: 1 });
  if (blobs.length === 0) return null;
  const headers: Record<string, string> = {};
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`;
  }
  const res = await fetch(blobs[0].url, { headers });
  if (!res.ok) return null;
  return res.text();
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const DATA_ROOT = path.join(process.cwd(), 'data', 'candles');

function localPath(symbol: string, market: 'TW' | 'CN'): string {
  return path.join(DATA_ROOT, market, `${symbol}.json`);
}

function blobKey(symbol: string, market: 'TW' | 'CN'): string {
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
    return data;
  } catch {
    return null;
  }
}

/**
 * 寫入 K 線原始 JSON
 */
export async function writeCandleFile(
  symbol: string,
  market: 'TW' | 'CN',
  candles: Candle[],
): Promise<void> {
  if (candles.length === 0) return;

  const stripped: Candle[] = candles.map(c => ({
    date: c.date, open: c.open, high: c.high,
    low: c.low, close: c.close, volume: c.volume,
  }));

  const lastDate = stripped[stripped.length - 1].date;
  const data: CandleFileData = {
    symbol,
    lastDate,
    updatedAt: new Date().toISOString(),
    candles: stripped,
  };

  const json = JSON.stringify(data);

  if (IS_VERCEL) {
    await blobPut(blobKey(symbol, market), json);
  }

  // 也嘗試寫本地（Vercel warm instance 可用；本地開發主要路徑）
  try {
    const dir = path.join(DATA_ROOT, market);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(localPath(symbol, market), json, 'utf-8');
  } catch {
    // Vercel 部署目錄可能是只讀的，忽略
  }
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
