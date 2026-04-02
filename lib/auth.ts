/**
 * Simple API authentication for sensitive endpoints.
 *
 * Uses a session-based approach compatible with Edge Runtime:
 * - First visit to the site sets a secure httpOnly cookie (`rs_session`)
 * - API requests with this cookie are allowed through
 * - Requests without a valid cookie get 401
 *
 * This prevents direct API abuse from external scripts while allowing
 * normal browser usage. For stronger auth, add user login later.
 */

import { NextRequest, NextResponse } from 'next/server';

// ── Session token management (Edge-compatible, no Node crypto) ────────────────

const SESSION_COOKIE = 'rs_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

/**
 * Secret used to sign session tokens.
 * Falls back to a random value per cold start if SESSION_SECRET not set.
 */
const SERVER_SECRET = process.env.SESSION_SECRET ?? crypto.randomUUID();

/** Convert ArrayBuffer to hex string */
function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Generate a random hex string */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bufToHex(arr.buffer);
}

/** SHA-256 hash (Edge-compatible) */
async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return bufToHex(hash);
}

/** Create a signed session token */
export async function createSessionToken(): Promise<string> {
  const payload = randomHex(16);
  const fullHash = await sha256Hex(payload + SERVER_SECRET);
  const signature = fullHash.slice(0, 16);
  return `${payload}.${signature}`;
}

/** Verify a session token's signature */
export async function verifySessionToken(token: string): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  const fullHash = await sha256Hex(payload + SERVER_SECRET);
  const expected = fullHash.slice(0, 16);
  return signature === expected;
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

/** Set session cookie on a response */
export async function setSessionCookie(
  response: NextResponse,
): Promise<NextResponse> {
  const token = await createSessionToken();
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
  return response;
}

/** Check if request has a valid session cookie */
export async function hasValidSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  return verifySessionToken(token);
}

// ── Protected routes configuration ────────────────────────────────────────────

/** Routes that require session auth (expensive / sensitive) */
export const PROTECTED_ROUTES = [
  '/api/ai/', // Claude API (costs money)
  '/api/chat', // Claude chat (costs money)
  '/api/notify/', // Email / LINE sending
  '/api/scanner/run', // Heavy compute
  '/api/scanner/chunk',
  '/api/backtest/', // Heavy compute
  '/api/daytrade/', // Heavy compute
];

/** Check if a pathname requires authentication */
export function isProtectedRoute(pathname: string): boolean {
  return PROTECTED_ROUTES.some((route) => pathname.startsWith(route));
}

// ── CORS configuration ────────────────────────────────────────────────────────

/** Allowed origins for API requests */
function getAllowedOrigins(): string[] {
  const origins = ['http://localhost:3000', 'http://localhost:3001'];
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (siteUrl) {
    origins.push(siteUrl);
  }
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
    origins.push(`https://${vercelUrl}`);
  }
  return origins;
}

/** Add CORS headers to response */
export function addCorsHeaders(
  req: NextRequest,
  response: NextResponse,
): NextResponse {
  const origin = req.headers.get('origin');
  const allowed = getAllowedOrigins();

  if (origin && allowed.some((o) => origin.startsWith(o))) {
    response.headers.set('Access-Control-Allow-Origin', origin);
  }
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Access-Control-Max-Age', '86400');

  return response;
}
