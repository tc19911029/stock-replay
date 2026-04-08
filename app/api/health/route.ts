import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  const checks: Record<string, 'ok' | 'missing' | 'error'> = {
    blob: 'missing',
    finmind: 'missing',
    eodhd: 'missing',
    cronSecret: 'missing',
  };

  // 1. Check env vars
  if (process.env.BLOB_READ_WRITE_TOKEN) checks.blob = 'ok';
  if (process.env.FINMIND_API_TOKEN) checks.finmind = 'ok';
  if (process.env.EODHD_API_TOKEN) checks.eodhd = 'ok';
  if (process.env.CRON_SECRET) checks.cronSecret = 'ok';

  // 2. Actually test Blob connectivity if token exists
  if (checks.blob === 'ok') {
    try {
      const { list } = await import('@vercel/blob');
      await list({ prefix: 'scans/', limit: 1 });
    } catch {
      checks.blob = 'error';
    }
  }

  const allOk = Object.values(checks).every(v => v === 'ok');

  return NextResponse.json({
    status: allOk ? 'healthy' : 'degraded',
    env: process.env.VERCEL ? 'vercel' : 'local',
    checks,
  }, { status: allOk ? 200 : 503 });
}
