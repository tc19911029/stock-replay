import { ScanSession, MarketId } from '@/lib/scanner/types';

// ── Storage abstraction for scan sessions ────────────────────────────────────
// Production (Vercel): uses Vercel Blob for durable persistence
// Local dev: uses filesystem (data/ directory)

const IS_VERCEL = !!process.env.VERCEL;

/** Summary entry returned by listScanDates */
export interface ScanDateEntry {
  market: MarketId;
  date: string;
  resultCount: number;
  scanTime: string;
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
  const res = await fetch(blobs[0].url);
  if (!res.ok) return null;
  return res.text();
}

async function blobListPrefix(prefix: string): Promise<Array<{ pathname: string; uploadedAt: Date }>> {
  const { list: blobList } = await import('@vercel/blob');
  const all: Array<{ pathname: string; uploadedAt: Date }> = [];
  let cursor: string | undefined;
  // paginate through all blobs with this prefix
  do {
    const result = await blobList({ prefix, limit: 100, cursor });
    all.push(...result.blobs.map(b => ({ pathname: b.pathname, uploadedAt: b.uploadedAt })));
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return all;
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

async function fsPut(filename: string, data: string): Promise<void> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const dir = path.join(process.cwd(), 'data');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), data, 'utf-8');
}

async function fsGet(filename: string): Promise<string | null> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  try {
    return await fs.readFile(path.join(process.cwd(), 'data', filename), 'utf-8');
  } catch {
    return null;
  }
}

async function fsListPrefix(prefix: string): Promise<string[]> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const dir = path.join(process.cwd(), 'data');
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => f.startsWith(prefix) && f.endsWith('.json'));
  } catch {
    return [];
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Save a scan session (cron or manual) */
export async function saveScanSession(session: ScanSession): Promise<void> {
  const data = JSON.stringify(session);
  const filename = `scan-${session.market}-${session.date}.json`;

  if (IS_VERCEL) {
    await blobPut(`scans/${session.market}/${session.date}.json`, data);
  }
  // Always write to local fs too (for local dev; on Vercel this goes to /tmp but that's ok as backup)
  try { await fsPut(filename, data); } catch { /* non-fatal on Vercel */ }
}

/** List all available scan dates for a market */
export async function listScanDates(market: MarketId): Promise<ScanDateEntry[]> {
  const entries: ScanDateEntry[] = [];

  if (IS_VERCEL) {
    const blobs = await blobListPrefix(`scans/${market}/`);
    for (const blob of blobs) {
      // pathname: scans/TW/2026-03-25.json → extract date
      const match = blob.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
      if (!match) continue;
      entries.push({
        market,
        date: match[1],
        resultCount: -1, // will be filled if needed
        scanTime: blob.uploadedAt.toISOString(),
      });
    }
  } else {
    // Local dev: read from data/ directory
    const files = await fsListPrefix(`scan-${market}-`);
    for (const file of files) {
      const match = file.match(/scan-\w+-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!match) continue;
      // Read file to get resultCount and scanTime
      try {
        const raw = await fsGet(file);
        if (raw) {
          const session = JSON.parse(raw) as ScanSession;
          entries.push({
            market,
            date: match[1],
            resultCount: session.resultCount,
            scanTime: session.scanTime,
          });
        }
      } catch {
        entries.push({
          market,
          date: match[1],
          resultCount: -1,
          scanTime: '',
        });
      }
    }
  }

  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

/** Load a specific scan session by market + date */
export async function loadScanSession(market: MarketId, date: string): Promise<ScanSession | null> {
  let raw: string | null = null;

  if (IS_VERCEL) {
    raw = await blobGet(`scans/${market}/${date}.json`);
  }

  // Fallback to local filesystem
  if (!raw) {
    raw = await fsGet(`scan-${market}-${date}.json`);
  }

  if (!raw) return null;

  try {
    return JSON.parse(raw) as ScanSession;
  } catch {
    return null;
  }
}
