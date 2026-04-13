import type { DabanScanSession } from '@/lib/scanner/types';

const IS_VERCEL = !!process.env.VERCEL;

// ── Helpers ────────────────────────────────────────────────────────────────

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
  } catch { return null; }
}

async function fsListPrefix(prefix: string): Promise<string[]> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  try {
    const files = await fs.readdir(path.join(process.cwd(), 'data'));
    return files.filter(f => f.startsWith(prefix) && f.endsWith('.json'));
  } catch { return []; }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function saveDabanSession(session: DabanScanSession): Promise<void> {
  const data = JSON.stringify(session);
  const filename = `daban-CN-${session.date}.json`;

  if (IS_VERCEL) {
    const { put } = await import('@vercel/blob');
    await put(`daban/CN/${session.date}.json`, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
  } else {
    await fsPut(filename, data);
  }
}

export async function loadDabanSession(date: string): Promise<DabanScanSession | null> {
  let raw: string | null = null;

  if (IS_VERCEL) {
    const { get } = await import('@vercel/blob');
    const result = await get(`daban/CN/${date}.json`, { access: 'private' });
    if (result && result.stream) {
      const reader = result.stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      raw = new TextDecoder().decode(Buffer.concat(chunks));
    }
  } else {
    raw = await fsGet(`daban-CN-${date}.json`);
  }

  if (!raw) return null;
  return JSON.parse(raw) as DabanScanSession;
}

export async function listDabanDates(): Promise<{ date: string; resultCount: number }[]> {
  const entries: { date: string; resultCount: number }[] = [];

  if (IS_VERCEL) {
    const { list: blobList } = await import('@vercel/blob');
    const { blobs } = await blobList({ prefix: 'daban/CN/', limit: 100 });
    for (const blob of blobs) {
      const match = blob.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
      if (match) entries.push({ date: match[1], resultCount: -1 });
    }
  } else {
    const files = await fsListPrefix('daban-CN-');
    for (const f of files) {
      const match = f.match(/daban-CN-(\d{4}-\d{2}-\d{2})\.json$/);
      if (match) {
        try {
          const raw = await fsGet(f);
          const session = raw ? JSON.parse(raw) as DabanScanSession : null;
          entries.push({ date: match[1], resultCount: session?.resultCount ?? -1 });
        } catch {
          entries.push({ date: match[1], resultCount: -1 });
        }
      }
    }
  }

  return entries.sort((a, b) => b.date.localeCompare(a.date));
}
