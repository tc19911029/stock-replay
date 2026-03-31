import { NextRequest, NextResponse } from 'next/server';
import { generalLimiter, aiLimiter, scanLimiter } from '@/lib/rateLimit';

/** Extract client IP from request headers */
function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

/** Routes that use AI (expensive) */
const AI_ROUTES = ['/api/chat', '/api/scanner/ai-rank'];

/** Routes that trigger scans (heavy compute) */
const SCAN_ROUTES = ['/api/scanner/run', '/api/scanner/chunk', '/api/backtest/scan'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Only rate-limit API routes
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Skip cron routes (already protected by bearer token)
  if (pathname.startsWith('/api/cron/')) {
    return NextResponse.next();
  }

  const ip = getClientIp(req);

  // Choose appropriate limiter
  let result;
  if (AI_ROUTES.some(r => pathname.startsWith(r))) {
    result = aiLimiter.check(ip);
  } else if (SCAN_ROUTES.some(r => pathname.startsWith(r))) {
    result = scanLimiter.check(ip);
  } else {
    result = generalLimiter.check(ip);
  }

  if (!result.success) {
    return NextResponse.json(
      { error: '請求過於頻繁，請稍後再試' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((result.retryAfter ?? 1000) / 1000)),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }

  const response = NextResponse.next();
  response.headers.set('X-RateLimit-Remaining', String(result.remaining));
  return response;
}

export const config = {
  matcher: '/api/:path*',
};
