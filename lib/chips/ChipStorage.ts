/**
 * 籌碼面 L1 儲存層（per-stock）
 *
 * 路徑：
 *   data/chips/TW/inst/{code}.json     法人買賣超（每股一檔，含所有日期）
 *
 * 設計：lazy fetch + 增量 merge。第一次走圖開籌碼 toggle 時抓 FinMind，存到 L1；
 * 之後 hits L1 cache，只補最新缺漏天。
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { InstDay, TdccDay, CnFlowDay, ChipSeries } from './types';

const ROOT = path.join(process.cwd(), 'data', 'chips', 'TW');
const INST_DIR = path.join(ROOT, 'inst');
const TDCC_DIR = path.join(ROOT, 'tdcc');
const CN_ROOT = path.join(process.cwd(), 'data', 'chips', 'CN');
const CN_FLOW_DIR = path.join(CN_ROOT, 'flow');

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

interface InstStockFile {
  symbol: string;            // pure code, e.g. '2330'
  market: 'TW';
  lastDate: string;          // 'YYYY-MM-DD'，最後一筆資料日
  updatedAt: string;
  data: Array<{ date: string } & InstDay>;  // 升冪 by date
}

export async function readInstStock(code: string): Promise<InstStockFile | null> {
  try {
    const raw = await fs.readFile(path.join(INST_DIR, `${code}.json`), 'utf8');
    return JSON.parse(raw) as InstStockFile;
  } catch {
    return null;
  }
}

/**
 * Merge 新資料到既有檔案（去重 by date，後者覆蓋）。
 */
export async function writeInstStock(
  code: string,
  newRows: Array<{ date: string } & InstDay>,
): Promise<InstStockFile> {
  await ensureDir(INST_DIR);
  const existing = await readInstStock(code);
  const map = new Map<string, { date: string } & InstDay>();
  for (const r of existing?.data ?? []) map.set(r.date, r);
  for (const r of newRows) map.set(r.date, r); // 後者覆蓋
  const merged = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  const file: InstStockFile = {
    symbol: code,
    market: 'TW',
    lastDate: merged[merged.length - 1]?.date ?? '',
    updatedAt: new Date().toISOString(),
    data: merged,
  };
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  await atomicFsPut(path.join(INST_DIR, `${code}.json`), JSON.stringify(file));
  return file;
}

// ── TDCC（大戶持股，週資料）──────────────────────────────────────────────────

interface TdccStockFile {
  symbol: string;
  market: 'TW';
  lastDate: string;          // 最後一筆基準日
  updatedAt: string;
  data: Array<{ date: string } & TdccDay>;
}

export async function readTdccStock(code: string): Promise<TdccStockFile | null> {
  try {
    const raw = await fs.readFile(path.join(TDCC_DIR, `${code}.json`), 'utf8');
    return JSON.parse(raw) as TdccStockFile;
  } catch {
    return null;
  }
}

/**
 * Merge 一週 TDCC 資料到 per-stock 檔（去重 by date，後者覆蓋）。
 * 通常一次跑全市場，輪流呼叫每支股。
 */
export async function appendTdccDay(
  code: string,
  date: string,
  row: TdccDay,
): Promise<void> {
  await fs.mkdir(TDCC_DIR, { recursive: true });
  const existing = await readTdccStock(code);
  const map = new Map<string, { date: string } & TdccDay>();
  for (const r of existing?.data ?? []) map.set(r.date, r);
  map.set(date, { date, ...row });
  const merged = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  const file: TdccStockFile = {
    symbol: code,
    market: 'TW',
    lastDate: merged[merged.length - 1]?.date ?? '',
    updatedAt: new Date().toISOString(),
    data: merged,
  };
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  await atomicFsPut(path.join(TDCC_DIR, `${code}.json`), JSON.stringify(file));
}

// ── CN 主力資金（EastMoney FFlow，每股一檔）─────────────────────────────────

interface CnFlowStockFile {
  symbol: string;
  market: 'CN';
  lastDate: string;
  updatedAt: string;
  data: Array<{ date: string } & CnFlowDay>;
}

export async function readCnFlowStock(code: string): Promise<CnFlowStockFile | null> {
  try {
    const raw = await fs.readFile(path.join(CN_FLOW_DIR, `${code}.json`), 'utf8');
    return JSON.parse(raw) as CnFlowStockFile;
  } catch {
    return null;
  }
}

export async function writeCnFlowStock(
  code: string,
  newRows: Array<{ date: string } & CnFlowDay>,
): Promise<CnFlowStockFile> {
  await fs.mkdir(CN_FLOW_DIR, { recursive: true });
  const existing = await readCnFlowStock(code);
  const map = new Map<string, { date: string } & CnFlowDay>();
  for (const r of existing?.data ?? []) map.set(r.date, r);
  for (const r of newRows) map.set(r.date, r);
  const merged = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  const file: CnFlowStockFile = {
    symbol: code,
    market: 'CN',
    lastDate: merged[merged.length - 1]?.date ?? '',
    updatedAt: new Date().toISOString(),
    data: merged,
  };
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  await atomicFsPut(path.join(CN_FLOW_DIR, `${code}.json`), JSON.stringify(file));
  return file;
}

/**
 * 讀單檔股票的籌碼時序（升冪 by date，最近 N 天）。
 * TW: 含 inst (日) + tdcc (週)
 * CN: 含 cnFlow (日)
 */
export async function loadChipSeries(code: string, days: number, market: 'TW' | 'CN' = 'TW'): Promise<ChipSeries> {
  if (market === 'CN') {
    const flowFile = await readCnFlowStock(code);
    return {
      symbol: code,
      inst: [],
      tdcc: [],
      cnFlow: (flowFile?.data ?? []).slice(-days),
    };
  }
  const [instFile, tdccFile] = await Promise.all([
    readInstStock(code),
    readTdccStock(code),
  ]);
  const inst = (instFile?.data ?? []).slice(-days);
  const tdccCount = Math.ceil(days / 5) + 4;
  const tdcc = (tdccFile?.data ?? []).slice(-tdccCount);
  return { symbol: code, inst, tdcc };
}
