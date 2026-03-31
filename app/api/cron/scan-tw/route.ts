import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ScanSession } from '@/lib/scanner/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const DATA_DIR = process.env.VERCEL ? '/tmp/scan-data' : path.join(process.cwd(), 'data');

export async function GET(req: NextRequest) {
  // Verify Vercel cron secret to prevent unauthorized triggers
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const scanner = new TaiwanScanner();
    const { results, partial, marketTrend } = await scanner.scan();
    const date = new Date().toISOString().split('T')[0];

    const session: ScanSession = {
      id: `TW-${date}-${Date.now()}`,
      market: 'TW',
      date,
      scanTime: new Date().toISOString(),
      resultCount: results.length,
      results,
    };

    // Persist result
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const filePath = path.join(DATA_DIR, `scan-TW-${date}.json`);
      await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
    } catch { /* storage failure shouldn't block notification */ }

    // Send email notification if configured
    const notifyEmail = process.env.NOTIFY_EMAIL;
    const resendKey = process.env.RESEND_API_KEY;
    if (notifyEmail && resendKey && results.length > 0) {
      try {
        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
        await fetch(`${siteUrl}/api/notify/email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: notifyEmail, results, market: 'TW' }),
        });
      } catch { /* notification failure is non-fatal */ }
    }

    return NextResponse.json({ ok: true, count: results.length, date, partial, marketTrend });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
