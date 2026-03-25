import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';

export const runtime = 'nodejs';
export const maxDuration = 60;
import path from 'path';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { ScanSession, MarketId } from '@/lib/scanner/types';

const DATA_DIR = process.env.VERCEL ? '/tmp/scan-data' : path.join(process.cwd(), 'data');

async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const market: MarketId = body.market === 'CN' ? 'CN' : 'TW';

  try {
    const scanner = market === 'TW' ? new TaiwanScanner() : new ChinaScanner();
    const results = await scanner.scan();
    const date    = new Date().toISOString().split('T')[0];

    const session: ScanSession = {
      id:          `${market}-${date}-${Date.now()}`,
      market,
      date,
      scanTime:    new Date().toISOString(),
      resultCount: results.length,
      results,
    };

    // Persist to /data/scan-{market}-{date}.json
    await ensureDataDir();
    const filePath = path.join(DATA_DIR, `scan-${market}-${date}.json`);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');

    return NextResponse.json({ ok: true, count: results.length, results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
