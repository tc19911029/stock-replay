/**
 * Same-origin guard for mutation endpoints.
 *
 * Browser fetch 對同源請求自動帶 Origin header，可以用來區分：
 *   ✅ 我們自己的 UI 透過 fetch 呼叫（Origin = self）
 *   ❌ 匿名 curl / 跨站攻擊（Origin 缺漏或 cross-origin）
 *
 * 不阻擋 server-side cron（無 Origin header）— 透過 checkCronAuth bearer token
 * 處理。同一個 endpoint 可同時接受兩種來源。
 *
 * 2026-05-08：原本 middleware 只 rate-limit、lib/auth.ts session 系統 dead code，
 *   POST /api/strategy/active 等任何匿名 curl 可改 active strategy 跑壞 cron。
 *   這個守門是 CSRF-style 補丁，不打壞既有 UI。
 *
 * 限制：
 *   - 無法區分「同站不同 user」（個人專案不需要）
 *   - 攻擊者在 browser 控制台發 fetch 仍通過（社交工程攻擊不擋）
 *   - 想要更強保護應上 Vercel Project Password Protection
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from './response';

/**
 * 檢查請求是否來自同源 browser fetch。
 *
 * @returns NextResponse 表示拒絕；null 表示通過。
 *
 * 通過條件（任一）：
 *   1. Origin / Referer header 跟 host 同源（browser 同站 fetch）
 *   2. 帶有效 cron bearer token（server-side cron）
 *   3. dev 環境（NODE_ENV !== 'production'）— 方便 local 測試
 */
export function checkSameOriginOrCron(req: NextRequest): NextResponse | null {
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  if (!isProd) return null; // dev 不擋，方便本地測試

  // Server-side cron 帶 bearer token：放行
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return null;

  // Browser fetch 同源檢查
  const host = req.headers.get('host');
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');

  if (!host) return apiError('Bad request: missing host', 400);

  // 接受 Origin（fetch 自動帶）OR Referer（form 提交帶）匹配 host
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost === host) return null;
    } catch { /* fallthrough */ }
  }
  if (referer) {
    try {
      const refererHost = new URL(referer).host;
      if (refererHost === host) return null;
    } catch { /* fallthrough */ }
  }

  return apiError('Forbidden: same-origin or cron token required', 403);
}
