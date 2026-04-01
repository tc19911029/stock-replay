import { NextRequest, NextResponse } from 'next/server';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { ScanSession } from '@/lib/scanner/types';
import { saveScanSession } from '@/lib/storage/scanStorage';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const scanner = new ChinaScanner();
    const { results, partial, marketTrend } = await scanner.scan();
    const date = new Date().toISOString().split('T')[0];

    const session: ScanSession = {
      id: `CN-${date}-${Date.now()}`,
      market: 'CN',
      date,
      scanTime: new Date().toISOString(),
      resultCount: results.length,
      results,
    };

    // Persist result (Vercel Blob in production, filesystem in dev)
    try {
      await saveScanSession(session);
    } catch { /* storage failure shouldn't block notification */ }

    const notifyEmail = process.env.NOTIFY_EMAIL;
    const resendKey = process.env.RESEND_API_KEY;
    if (notifyEmail && resendKey && results.length > 0) {
      try {
        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
        await fetch(`${siteUrl}/api/notify/email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: notifyEmail, results, market: 'CN' }),
        });
      } catch { /* notification failure is non-fatal */ }
    }

    return NextResponse.json({ ok: true, count: results.length, date, partial, marketTrend });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
