/**
 * Cron route auth helper
 *
 * Production: CRON_SECRET 必須設定且 header 必須匹配；否則 401/500
 * Development: 若未設 CRON_SECRET，允許未驗證呼叫（方便 local 手動觸發）
 *
 * 修復 Round 12：原 pattern `if (CRON_SECRET && header !== ...)` 在 env 未設時完全
 * skip auth，造成 production 若 secret 不慎未設，cron 路由變成公開 DoS 入口。
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from './response';

/**
 * 驗證 cron 請求。回傳 NextResponse 表示拒絕（呼叫端應 return 出去）；
 * 回傳 null 表示通過。
 *
 * 用法：
 *   const denied = checkCronAuth(req);
 *   if (denied) return denied;
 */
export function checkCronAuth(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';

  if (isProd) {
    if (!secret) {
      console.error('[cron] CRON_SECRET not configured in production');
      return apiError('CRON_SECRET not configured', 500);
    }
    if (authHeader !== `Bearer ${secret}`) {
      return apiError('Unauthorized', 401);
    }
    return null;
  }

  // dev：若有設 secret 就要求匹配；沒設就放行（方便 local 手動測 cron）
  if (secret && authHeader !== `Bearer ${secret}`) {
    return apiError('Unauthorized', 401);
  }
  return null;
}
