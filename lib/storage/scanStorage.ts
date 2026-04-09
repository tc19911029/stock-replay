import { ScanSession, MarketId, ScanDirection, MtfMode } from '@/lib/scanner/types';
import { isWeekday } from '@/lib/utils/tradingDay';

// ── Storage abstraction for scan sessions ────────────────────────────────────
// Production (Vercel): uses Vercel Blob for durable persistence
// Local dev: uses filesystem (data/ directory)

const IS_VERCEL = !!process.env.VERCEL;

if (IS_VERCEL && !process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('[scanStorage] BLOB_READ_WRITE_TOKEN 未設定，Blob 操作將失敗。請至 Vercel Dashboard → Storage 建立 Blob Store 並連接專案');
}

/** Summary entry returned by listScanDates */
export interface ScanDateEntry {
  market: MarketId;
  date: string;
  direction?: ScanDirection;
  mtfMode?: MtfMode;
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
  const headers: Record<string, string> = {};
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`;
  }
  const res = await fetch(blobs[0].url, { headers });
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Derive MTF mode from session */
function sessionMtfMode(session: ScanSession): MtfMode {
  return session.multiTimeframeEnabled ? 'mtf' : 'daily';
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Save a scan session (cron or manual) */
export async function saveScanSession(session: ScanSession): Promise<void> {
  const data = JSON.stringify(session);
  const dir = session.direction ?? 'long';
  const mtf = sessionMtfMode(session);
  const filename = `scan-${session.market}-${dir}-${mtf}-${session.date}.json`;

  if (IS_VERCEL) {
    await blobPut(`scans/${session.market}/${dir}/${mtf}/${session.date}.json`, data);
  } else {
    await fsPut(filename, data);
  }
}

/** List all available scan dates for a market + direction + optional mtfMode */
export async function listScanDates(
  market: MarketId,
  direction: ScanDirection = 'long',
  mtfMode?: MtfMode,
): Promise<ScanDateEntry[]> {
  const entries: ScanDateEntry[] = [];
  const modes: MtfMode[] = mtfMode ? [mtfMode] : ['daily', 'mtf'];

  if (IS_VERCEL) {
    try {
      for (const m of modes) {
        // New MTF-aware path
        const blobs = await blobListPrefix(`scans/${market}/${direction}/${m}/`);
        for (const blob of blobs) {
          const match = blob.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
          if (!match) continue;
          entries.push({
            market, direction, mtfMode: m,
            date: match[1], resultCount: -1,
            scanTime: blob.uploadedAt.toISOString(),
          });
        }
      }

      // Fallback: check old direction-aware path (no mtf subfolder)
      if (entries.length === 0) {
        const blobs = await blobListPrefix(`scans/${market}/${direction}/`);
        for (const blob of blobs) {
          // Skip mtf subfolders
          if (blob.pathname.includes('/daily/') || blob.pathname.includes('/mtf/')) continue;
          const match = blob.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
          if (!match) continue;
          entries.push({
            market, direction, mtfMode: 'daily',
            date: match[1], resultCount: -1,
            scanTime: blob.uploadedAt.toISOString(),
          });
        }
      }

      // Fallback: legacy path (no direction, no mtf)
      if (entries.length === 0 && direction === 'long') {
        const legacyBlobs = await blobListPrefix(`scans/${market}/`);
        for (const blob of legacyBlobs) {
          if (blob.pathname.includes('/long/') || blob.pathname.includes('/short/')) continue;
          if (blob.pathname.includes('/daily/') || blob.pathname.includes('/mtf/')) continue;
          const match = blob.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
          if (!match) continue;
          entries.push({
            market, direction: 'long', mtfMode: 'daily',
            date: match[1], resultCount: -1,
            scanTime: blob.uploadedAt.toISOString(),
          });
        }
      }
    } catch (err) {
      console.error('[scanStorage] Blob listScanDates failed (token missing?):', err);
    }
  } else {
    // Local dev: read from data/ directory
    for (const m of modes) {
      const files = await fsListPrefix(`scan-${market}-${direction}-${m}-`);
      for (const file of files) {
        const match = file.match(/(\d{4}-\d{2}-\d{2})\.json$/);
        if (!match) continue;
        try {
          const raw = await fsGet(file);
          if (raw) {
            const session = JSON.parse(raw) as ScanSession;
            entries.push({
              market, direction, mtfMode: m,
              date: match[1],
              resultCount: session.resultCount,
              scanTime: session.scanTime,
            });
          }
        } catch {
          entries.push({
            market, direction, mtfMode: m,
            date: match[1], resultCount: -1, scanTime: '',
          });
        }
      }
    }

    // Always merge legacy format files (old format without direction/mtf dimension)
    // so that new-format and old-format records coexist seamlessly.
    {
      let files = await fsListPrefix(`scan-${market}-${direction}-`);
      // Filter out new-format files (already read above)
      files = files.filter(f => !f.includes('-daily-') && !f.includes('-mtf-'));
      // Legacy fallback (no direction prefix)
      if (files.length === 0 && direction === 'long') {
        const legacyFiles = await fsListPrefix(`scan-${market}-`);
        files = legacyFiles.filter(f => !f.includes('-long-') && !f.includes('-short-') && !f.includes('-daily-') && !f.includes('-mtf-'));
      }
      for (const file of files) {
        const match = file.match(/(\d{4}-\d{2}-\d{2})\.json$/);
        if (!match) continue;
        try {
          const raw = await fsGet(file);
          if (raw) {
            const session = JSON.parse(raw) as ScanSession;
            entries.push({
              market, direction, mtfMode: 'daily',
              date: match[1],
              resultCount: session.resultCount,
              scanTime: session.scanTime,
            });
          }
        } catch {
          entries.push({
            market, direction, mtfMode: 'daily',
            date: match[1], resultCount: -1, scanTime: '',
          });
        }
      }
    }
  }

  // Deduplicate by date+mtfMode (keep latest scanTime)
  const seen = new Map<string, ScanDateEntry>();
  for (const e of entries) {
    const key = `${e.date}-${e.mtfMode}`;
    const existing = seen.get(key);
    if (!existing || e.scanTime > existing.scanTime) {
      seen.set(key, e);
    }
  }

  // Filter out non-trading days (weekends + holidays) that may have been backfilled incorrectly
  return [...seen.values()]
    .filter(e => isWeekday(e.date, e.market as 'TW' | 'CN'))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Load a specific scan session by market + date + direction + mtfMode */
export async function loadScanSession(
  market: MarketId,
  date: string,
  direction: ScanDirection = 'long',
  mtfMode: MtfMode = 'daily',
): Promise<ScanSession | null> {
  let raw: string | null = null;

  if (IS_VERCEL) {
    try {
      // New MTF-aware path
      raw = await blobGet(`scans/${market}/${direction}/${mtfMode}/${date}.json`);
      // Fallback: old direction path (no mtf) — only for daily mode
      // (old format data was effectively daily-only; don't serve it for mtf requests)
      if (!raw && mtfMode === 'daily') {
        raw = await blobGet(`scans/${market}/${direction}/${date}.json`);
      }
      // Fallback: legacy path (no direction) — only for daily + long
      if (!raw && mtfMode === 'daily' && direction === 'long') {
        raw = await blobGet(`scans/${market}/${date}.json`);
      }
    } catch (err) {
      console.error('[scanStorage] Blob loadScanSession failed (token missing?):', err);
    }
  }

  // Local filesystem: new format
  if (!raw) {
    raw = await fsGet(`scan-${market}-${direction}-${mtfMode}-${date}.json`);
  }
  // Fallback: old format without mtf — only for daily mode
  if (!raw && mtfMode === 'daily') {
    raw = await fsGet(`scan-${market}-${direction}-${date}.json`);
  }
  // Legacy fallback — only for daily + long
  if (!raw && mtfMode === 'daily' && direction === 'long') {
    raw = await fsGet(`scan-${market}-${date}.json`);
  }

  if (!raw) return null;

  try {
    return JSON.parse(raw) as ScanSession;
  } catch {
    return null;
  }
}
