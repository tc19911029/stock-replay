import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';

export const runtime = 'nodejs';
import path from 'path';
import { ScanSession, MarketId } from '@/lib/scanner/types';

const DATA_DIR = process.env.VERCEL ? '/tmp/scan-data' : path.join(process.cwd(), 'data');

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const market: MarketId = searchParams.get('market') === 'CN' ? 'CN' : 'TW';
  const dateParam = searchParams.get('date'); // optional YYYY-MM-DD

  try {
    const files = await fs.readdir(DATA_DIR).catch(() => [] as string[]);
    const prefix = `scan-${market}-`;

    // Filter and sort by filename (date) descending
    const matching = files
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .sort()
      .reverse();

    if (dateParam) {
      // Return the specific date session
      const targetFile = matching.find(f => f.includes(dateParam));
      if (!targetFile) return NextResponse.json({ sessions: [] });
      const raw = await fs.readFile(path.join(DATA_DIR, targetFile), 'utf-8');
      const session: ScanSession = JSON.parse(raw);
      return NextResponse.json({ sessions: [session] });
    }

    // Return last 30 days of sessions (summary only)
    const sessions: Pick<ScanSession, 'id' | 'market' | 'date' | 'scanTime' | 'resultCount'>[] = [];
    for (const file of matching.slice(0, 30)) {
      try {
        const raw = await fs.readFile(path.join(DATA_DIR, file), 'utf-8');
        const { id, market: m, date, scanTime, resultCount } = JSON.parse(raw) as ScanSession;
        sessions.push({ id, market: m, date, scanTime, resultCount });
      } catch {}
    }

    return NextResponse.json({ sessions });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
