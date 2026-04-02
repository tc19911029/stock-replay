import { NextRequest, NextResponse } from 'next/server';
import { generalLimiter, aiLimiter, scanLimiter } from '@/lib/rateLimit';
import {
  hasValidSession,
  setSessionCookie,
  isProtectedRoute,
  addCorsHeaders,
} from '@/lib/auth';

/** Extract client IP from request headers */
function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

/** Routes that use AI (expensive) */
const AI_ROUTES = ['/api/chat', '/api/scanner/ai-rank', '/api/ai/analyze'];

/** Routes that trigger scans (heavy compute) */
const SCAN_ROUTES = [
  '/api/scanner/run',
  '/api/scanner/chunk',
  '/api/backtest/scan',
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── Page requests: ensure session cookie exists ───────────────────────────
  if (!pathname.startsWith('/api/')) {
    const valid = await hasValidSession(req);
    if (!valid) {
      const response = NextResponse.next();
      return setSessionCookie(response);
    }
    return NextResponse.next();
  }

  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 204 });
    return addCorsHeaders(req, response);
  }

  // ── Skip cron routes (already protected by bearer token) ────────────────────
  if (pathname.startsWith('/api/cron/')) {
    return NextResponse.next();
  }

  // ── Auth check for protected routes ─────────────────────────────────────────
  if (isProtectedRoute(pathname)) {
    const valid = await hasValidSession(req);
    if (!valid) {
      return NextResponse.json(
        { error: '未授權存取，請透過網頁操作' },
        { status: 401 },
      );
    }
  }

  // ── Rate limiting ───────────────────────────────────────────────────────────
  const ip = getClientIp(req);

  let result;
  if (AI_ROUTES.some((r) => pathname.startsWith(r))) {
    result = aiLimiter.check(ip);
  } else if (SCAN_ROUTES.some((r) => pathname.startsWith(r))) {
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
      },
    );
  }

  const response = NextResponse.next();
  response.headers.set('X-RateLimit-Remaining', String(result.remaining));
  return addCorsHeaders(req, response);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|icon-).*)',
  ],
};
