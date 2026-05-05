/**
 * Standardized API response helpers.
 *
 * 實際 wire format（與下方 helper 行為一致）：
 *   Success: { ok: true, ...data }      ← apiOk(data) 把 data 物件 spread 到頂層
 *   Error:   { error: string }          ← apiError(message, status)
 *
 * 注意：這跟一般 envelope 慣例 `{ success, data }` 不同，是歷史遺留向下相容形狀；
 * 客戶端要讀 ok 而非 success，且要在頂層拿 data 欄位。
 *
 * Usage:
 *   return apiOk({ candles, ticker });    → { ok: true, candles, ticker }
 *   return apiError('找不到股票資料', 404);
 *   return apiValidationError(zodResult.error);
 */

import { NextResponse } from 'next/server';
import type { ZodError } from 'zod';

/** Return a success response — spreads data at top level for backwards compatibility */
export function apiOk<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, ...(data as object) }, init);
}

/** Return an error response — uses { error } for backwards compatibility */
export function apiError(
  message: string,
  status = 500,
  headers?: Record<string, string>,
): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers },
  );
}

/** Return a validation error from Zod */
export function apiValidationError(
  error: ZodError,
): NextResponse {
  const message = error.issues[0]?.message ?? '輸入格式錯誤';
  return apiError(message, 400);
}

/** Return a rate limit error */
export function apiRateLimited(retryAfterMs: number): NextResponse {
  return apiError('請求過於頻繁，請稍後再試', 429, {
    'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
    'X-RateLimit-Remaining': '0',
  });
}
