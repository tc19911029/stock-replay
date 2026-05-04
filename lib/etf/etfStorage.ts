/**
 * 主動式 ETF 追蹤器 — Dual-mode storage（Vercel Blob ↔ Local FS）
 *
 * Layout：
 *   etf/snapshots/{etfCode}/{YYYY-MM-DD}.json     ← ETFSnapshot
 *   etf/changes/{etfCode}/{YYYY-MM-DD}.json       ← ETFChange
 *   etf/tracking/{etfCode}/{symbol}-{addedDate}.json  ← ETFTrackingEntry
 *   etf/performance/{YYYY-MM-DD}.json             ← ETFPerformanceEntry[]
 *   etf/consensus/{YYYY-MM-DD}.json               ← ETFConsensusEntry[]
 *
 * 跟隨 lib/storage/institutionalStorage.ts 的 IS_VERCEL pattern。
 */
import { promises as fs } from 'fs';
import path from 'path';
import type {
  ETFSnapshot,
  ETFChange,
  ETFTrackingEntry,
  ETFPerformanceEntry,
  ETFConsensusEntry,
} from './types';

const IS_VERCEL = process.env.VERCEL === '1';
const DATA_ROOT = path.join(process.cwd(), 'data', 'etf');

// ── 路徑/Key 計算 ─────────────────────────────────────────────

function snapshotBlob(etfCode: string, date: string): string {
  return `etf/snapshots/${etfCode}/${date}.json`;
}
function snapshotLocal(etfCode: string, date: string): string {
  return path.join(DATA_ROOT, 'snapshots', `etf-snap-${etfCode}-${date}.json`);
}

function changeBlob(etfCode: string, date: string): string {
  return `etf/changes/${etfCode}/${date}.json`;
}
function changeLocal(etfCode: string, date: string): string {
  return path.join(DATA_ROOT, 'changes', `etf-change-${etfCode}-${date}.json`);
}

function trackingBlob(etfCode: string, symbol: string, addedDate: string): string {
  return `etf/tracking/${etfCode}/${symbol}-${addedDate}.json`;
}
function trackingLocal(etfCode: string, symbol: string, addedDate: string): string {
  return path.join(DATA_ROOT, 'tracking', `etf-track-${etfCode}-${symbol}-${addedDate}.json`);
}

function performanceBlob(date: string): string {
  return `etf/performance/${date}.json`;
}
function performanceLocal(date: string): string {
  return path.join(DATA_ROOT, 'performance', `etf-perf-${date}.json`);
}

function consensusBlob(date: string): string {
  return `etf/consensus/${date}.json`;
}
function consensusLocal(date: string): string {
  return path.join(DATA_ROOT, 'consensus', `etf-consensus-${date}.json`);
}

// ── 核心 IO（共用） ───────────────────────────────────────────

async function writeJSON(blobKey: string, localFile: string, payload: unknown): Promise<void> {
  const data = JSON.stringify(payload);
  if (IS_VERCEL) {
    const { put } = await import('@vercel/blob');
    await put(blobKey, data, { access: 'public', addRandomSuffix: false, allowOverwrite: true });
  } else {
    const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
    await fs.mkdir(path.dirname(localFile), { recursive: true });
    await atomicFsPut(localFile, data);
  }
}

async function readJSON<T>(blobKey: string, localFile: string): Promise<T | null> {
  try {
    if (IS_VERCEL) {
      const { head } = await import('@vercel/blob');
      const meta = await head(blobKey);
      const res = await fetch(meta.url);
      if (!res.ok) return null;
      return (await res.json()) as T;
    }
    const data = await fs.readFile(localFile, 'utf-8');
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

async function listBlobPrefix(prefix: string): Promise<string[]> {
  if (!IS_VERCEL) return [];
  const { list } = await import('@vercel/blob');
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await list({ prefix, cursor, limit: 1000 });
    for (const b of result.blobs) out.push(b.pathname);
    cursor = result.cursor;
  } while (cursor);
  return out;
}

async function listLocalDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

// ── ETFSnapshot ──────────────────────────────────────────────

export async function saveETFSnapshot(snap: ETFSnapshot): Promise<void> {
  await writeJSON(snapshotBlob(snap.etfCode, snap.disclosureDate), snapshotLocal(snap.etfCode, snap.disclosureDate), snap);
}

export async function loadETFSnapshot(etfCode: string, date: string): Promise<ETFSnapshot | null> {
  return readJSON<ETFSnapshot>(snapshotBlob(etfCode, date), snapshotLocal(etfCode, date));
}

export async function listSnapshotDates(etfCode: string): Promise<string[]> {
  if (IS_VERCEL) {
    const keys = await listBlobPrefix(`etf/snapshots/${etfCode}/`);
    return keys
      .map((k) => k.split('/').pop()?.replace('.json', '') ?? '')
      .filter(Boolean)
      .sort()
      .reverse();
  }
  const files = await listLocalDir(path.join(DATA_ROOT, 'snapshots'));
  const prefix = `etf-snap-${etfCode}-`;
  return files
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => f.slice(prefix.length, -'.json'.length))
    .sort()
    .reverse();
}

export async function loadLatestETFSnapshot(etfCode: string): Promise<ETFSnapshot | null> {
  const dates = await listSnapshotDates(etfCode);
  if (dates.length === 0) return null;
  return loadETFSnapshot(etfCode, dates[0]);
}

// ── ETFChange ────────────────────────────────────────────────

export async function saveETFChange(change: ETFChange): Promise<void> {
  await writeJSON(changeBlob(change.etfCode, change.toDate), changeLocal(change.etfCode, change.toDate), change);
}

export async function loadETFChange(etfCode: string, date: string): Promise<ETFChange | null> {
  return readJSON<ETFChange>(changeBlob(etfCode, date), changeLocal(etfCode, date));
}

export async function listChangeDates(etfCode: string): Promise<string[]> {
  if (IS_VERCEL) {
    const keys = await listBlobPrefix(`etf/changes/${etfCode}/`);
    return keys
      .map((k) => k.split('/').pop()?.replace('.json', '') ?? '')
      .filter(Boolean)
      .sort()
      .reverse();
  }
  const files = await listLocalDir(path.join(DATA_ROOT, 'changes'));
  const prefix = `etf-change-${etfCode}-`;
  return files
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => f.slice(prefix.length, -'.json'.length))
    .sort()
    .reverse();
}

export async function loadAllChangesForDate(date: string, etfCodes: string[]): Promise<ETFChange[]> {
  const out: ETFChange[] = [];
  for (const code of etfCodes) {
    const change = await loadETFChange(code, date);
    if (change) out.push(change);
  }
  return out;
}

export async function loadRecentChanges(etfCode: string, n: number): Promise<ETFChange[]> {
  const dates = (await listChangeDates(etfCode)).slice(0, n);
  const out: ETFChange[] = [];
  for (const d of dates) {
    const c = await loadETFChange(etfCode, d);
    if (c) out.push(c);
  }
  return out;
}

// ── ETFTrackingEntry ─────────────────────────────────────────

export async function saveTrackingEntry(entry: ETFTrackingEntry): Promise<void> {
  await writeJSON(
    trackingBlob(entry.etfCode, entry.symbol, entry.addedDate),
    trackingLocal(entry.etfCode, entry.symbol, entry.addedDate),
    entry,
  );
}

export async function loadTrackingEntry(
  etfCode: string,
  symbol: string,
  addedDate: string,
): Promise<ETFTrackingEntry | null> {
  return readJSON<ETFTrackingEntry>(
    trackingBlob(etfCode, symbol, addedDate),
    trackingLocal(etfCode, symbol, addedDate),
  );
}

export async function listAllTrackingEntries(filterEtf?: string): Promise<ETFTrackingEntry[]> {
  const out: ETFTrackingEntry[] = [];
  if (IS_VERCEL) {
    const prefix = filterEtf ? `etf/tracking/${filterEtf}/` : 'etf/tracking/';
    const keys = await listBlobPrefix(prefix);
    for (const key of keys) {
      const data = await readJSON<ETFTrackingEntry>(key, '');
      if (data) out.push(data);
    }
  } else {
    const files = await listLocalDir(path.join(DATA_ROOT, 'tracking'));
    const prefix = filterEtf ? `etf-track-${filterEtf}-` : 'etf-track-';
    for (const f of files) {
      if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
      const data = await readJSON<ETFTrackingEntry>('', path.join(DATA_ROOT, 'tracking', f));
      if (data) out.push(data);
    }
  }
  return out;
}

// ── ETFPerformanceEntry[] ────────────────────────────────────

export async function savePerformance(date: string, entries: ETFPerformanceEntry[]): Promise<void> {
  await writeJSON(performanceBlob(date), performanceLocal(date), { date, entries });
}

export async function loadPerformance(date: string): Promise<ETFPerformanceEntry[] | null> {
  const data = await readJSON<{ entries: ETFPerformanceEntry[] }>(performanceBlob(date), performanceLocal(date));
  return data?.entries ?? null;
}

export async function listPerformanceDates(): Promise<string[]> {
  if (IS_VERCEL) {
    const keys = await listBlobPrefix('etf/performance/');
    return keys
      .map((k) => k.split('/').pop()?.replace('.json', '') ?? '')
      .filter(Boolean)
      .sort()
      .reverse();
  }
  const files = await listLocalDir(path.join(DATA_ROOT, 'performance'));
  return files
    .filter((f) => f.startsWith('etf-perf-') && f.endsWith('.json'))
    .map((f) => f.slice('etf-perf-'.length, -'.json'.length))
    .sort()
    .reverse();
}

// ── ETFConsensusEntry[] ──────────────────────────────────────

export async function saveConsensus(date: string, entries: ETFConsensusEntry[]): Promise<void> {
  await writeJSON(consensusBlob(date), consensusLocal(date), { date, entries });
}

export async function loadConsensus(date: string): Promise<ETFConsensusEntry[] | null> {
  const data = await readJSON<{ entries: ETFConsensusEntry[] }>(consensusBlob(date), consensusLocal(date));
  return data?.entries ?? null;
}

export async function listConsensusDates(): Promise<string[]> {
  if (IS_VERCEL) {
    const keys = await listBlobPrefix('etf/consensus/');
    return keys
      .map((k) => k.split('/').pop()?.replace('.json', '') ?? '')
      .filter(Boolean)
      .sort()
      .reverse();
  }
  const files = await listLocalDir(path.join(DATA_ROOT, 'consensus'));
  return files
    .filter((f) => f.startsWith('etf-consensus-') && f.endsWith('.json'))
    .map((f) => f.slice('etf-consensus-'.length, -'.json'.length))
    .sort()
    .reverse();
}
