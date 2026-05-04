/**
 * CN 主力資金流儲存層
 * 類似 institutionalStorage (TW) 但針對 A 股
 *
 * 儲存方式：per-date JSON 含所有 symbol 當日主力淨流入
 * Key: capital-flow/CN/YYYY-MM-DD.json
 */

import { promises as fs } from 'fs';
import path from 'path';

const IS_VERCEL = process.env.VERCEL === '1';
const DATA_DIR = path.join(process.cwd(), 'data', 'capital-flow');

export interface CapitalFlowRecord {
  symbol:  string;   // 純數字 e.g. '600519'
  mainNet: number;   // 主力淨流入（元）
}

interface StoredDay {
  date:    string;
  count:   number;
  records: CapitalFlowRecord[];
}

function localPath(date: string): string {
  return path.join(DATA_DIR, `CN-${date}.json`);
}

function blobKey(date: string): string {
  return `capital-flow/CN/${date}.json`;
}

export async function saveCapitalFlowCN(
  date: string, records: CapitalFlowRecord[],
): Promise<void> {
  const payload: StoredDay = { date, count: records.length, records };
  const data = JSON.stringify(payload);
  if (IS_VERCEL) {
    const { put } = await import('@vercel/blob');
    await put(blobKey(date), data, {
      access: 'private', addRandomSuffix: false, allowOverwrite: true,
    });
  } else {
    const { atomicFsPut } = await import('./atomicFsPut');
    await fs.mkdir(DATA_DIR, { recursive: true });
    await atomicFsPut(localPath(date), data);
  }
}

export async function readCapitalFlowCN(date: string): Promise<CapitalFlowRecord[] | null> {
  try {
    if (IS_VERCEL) {
      const { get } = await import('@vercel/blob');
      const result = await get(blobKey(date), { access: 'private' });
      if (!result?.stream) return null;
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
 * 批次讀近 N 個交易日 CN 主力資金流 → Map<symbol, [{date, netShares}]>
 * 返回格式對齊 TW 的 institutional history，方便共用 ProhibitionContext
 */
export async function buildCapitalFlowMapCN(
  endDate: string, lookbackDays: number,
): Promise<Map<string, Array<{ date: string; netShares: number }>>> {
  const dates: string[] = [];
  const cursor = new Date(endDate + 'T00:00:00Z');
  while (dates.length < lookbackDays + 10) {
    const iso = cursor.toISOString().slice(0, 10);
    dates.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  const map = new Map<string, Array<{ date: string; netShares: number }>>();
  for (const d of dates) {
    const records = await readCapitalFlowCN(d);
    if (!records) continue;
    for (const r of records) {
      const hist = map.get(r.symbol);
      const entry = { date: d, netShares: r.mainNet };
      if (hist) hist.push(entry);
      else map.set(r.symbol, [entry]);
    }
    if (map.size > 0 && [...map.values()][0].length >= lookbackDays) break;
  }
  for (const [sym, hist] of map) {
    map.set(sym, hist.slice(0, lookbackDays));
  }
  return map;
}
