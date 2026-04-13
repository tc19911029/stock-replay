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
    // 收盤 cron 寫入時自動封存（Fundamental Rule R1）
    sealedDate: lastDate,
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
