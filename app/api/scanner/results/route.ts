import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { promises as fs } from 'fs';

export const runtime = 'nodejs';
import path from 'path';
import { ScanSession, MarketId } from '@/lib/scanner/types';

const DATA_DIR = process.env.VERCEL ? '/tmp/scan-data' : path.join(process.cwd(), 'data');

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  const market: MarketId = parsed.data.market;
  const dateParam = parsed.data.date;

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
    console.error('[scanner/results] error:', err);
    return NextResponse.json({ error: '掃描服務暫時無法使用' }, { status: 500 });
  }
}
