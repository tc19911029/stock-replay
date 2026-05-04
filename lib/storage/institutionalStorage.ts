/**
 * 三大法人買賣超儲存層（TW）
 *
 * 儲存格式：Vercel 用 Blob，本地用 fs。
 * Key: `institutional/TW/YYYY-MM-DD.json`
 *
 * 每日一檔（類似 L2 intraday 快照模型）。
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { InstitutionalRecord } from '@/lib/datasource/TWSEInstitutional';

const IS_VERCEL = process.env.VERCEL === '1';
const DATA_DIR = path.join(process.cwd(), 'data', 'institutional');

interface StoredDay {
  date:    string;   // YYYY-MM-DD
  count:   number;
  records: InstitutionalRecord[];
}

function localPath(date: string): string {
  return path.join(DATA_DIR, `TW-${date}.json`);
}

function blobKey(date: string): string {
  return `institutional/TW/${date}.json`;
}

export async function saveInstitutionalTW(
  date: string,
  records: InstitutionalRecord[],
): Promise<void> {
  const payload: StoredDay = { date, count: records.length, records };
  const data = JSON.stringify(payload);

  if (IS_VERCEL) {
    const { put } = await import('@vercel/blob');
    await put(blobKey(date), data, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } else {
    const { atomicFsPut } = await import('./atomicFsPut');
    await fs.mkdir(DATA_DIR, { recursive: true });
    await atomicFsPut(localPath(date), data);
  }
}

export async function readInstitutionalTW(date: string): Promise<InstitutionalRecord[] | null> {
  try {
    if (IS_VERCEL) {
      const { get } = await import('@vercel/blob');
      const result = await get(blobKey(date), { access: 'private' });
      if (!result || !result.stream) return null;
      const reader = result.stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const text = new TextDecoder().decode(Buffer.concat(chunks));
      const stored = JSON.parse(text) as StoredDay;
      return stored.records;
    } else {
      const data = await fs.readFile(localPath(date), 'utf-8');
      const stored = JSON.parse(data) as StoredDay;
      return stored.records;
    }
  } catch {
    return null;
  }
}

/**
 * 取近 N 個交易日的某股三大法人淨買賣（由新到舊）
 */
export async function getInstitutionalHistoryTW(
  symbol: string,
  endDate: string,
  lookbackDays: number,
  availableDates: string[],  // caller 提供的交易日清單（由新到舊）
): Promise<Array<{ date: string; netShares: number }>> {
  const dates = availableDates
    .filter(d => d <= endDate)
    .slice(0, lookbackDays);
  const out: Array<{ date: string; netShares: number }> = [];
  for (const d of dates) {
    const records = await readInstitutionalTW(d);
    if (!records) continue;
    const rec = records.find(r => r.symbol === symbol);
    out.push({ date: d, netShares: rec?.total ?? 0 });
  }
  return out;
}

/**
 * 批次讀近 N 個交易日 TW 法人資料 → 建立每股的歷史 map（給 scanner pre-load）
 * 返回 Map<symbol, Array<{ date, netShares }>>（由新到舊）
 */
export async function buildInstitutionalMapTW(
  endDate: string,
  lookbackDays: number,
): Promise<Map<string, Array<{ date: string; netShares: number }>>> {
  // 從 endDate 往前找日期（日期格式 YYYY-MM-DD）
  const dates: string[] = [];
  const cursor = new Date(endDate + 'T00:00:00Z');
  while (dates.length < lookbackDays + 10) {  // 多抓幾天容錯非交易日
    const iso = cursor.toISOString().slice(0, 10);
    dates.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  const map = new Map<string, Array<{ date: string; netShares: number }>>();
  for (const d of dates) {
    const records = await readInstitutionalTW(d);
    if (!records) continue;
    for (const r of records) {
      const hist = map.get(r.symbol);
      const entry = { date: d, netShares: r.total };
      if (hist) hist.push(entry);
      else map.set(r.symbol, [entry]);
    }
    if (map.size > 0 && [...map.values()][0].length >= lookbackDays) break;
  }

  // 取每股前 N 天（由新到舊）
  for (const [sym, hist] of map) {
    map.set(sym, hist.slice(0, lookbackDays));
  }
  return map;
}
