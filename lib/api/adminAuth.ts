/**
 * Admin endpoint authentication.
 *
 * 所有 /api/admin/* 路由必須通過 x-admin-secret header 驗證
 * （或退而求其次使用 x-upload-secret 兼容既有腳本）。
 *
 * Production 沒設 ADMIN_SECRET 時所有 admin 端點 503，避免裸露。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * 驗證 admin secret。回傳 NextResponse 表示拒絕；null 表示通過。
 *
 * 接受的 header（任一）：
 *   - x-admin-secret  → ADMIN_SECRET
 *   - x-upload-secret → UPLOAD_SECRET（向後兼容 upload-candles 工具）
 */
export function checkAdminAuth(req: NextRequest): NextResponse | null {
  const adminSecret = process.env.ADMIN_SECRET;
  const uploadSecret = process.env.UPLOAD_SECRET;

  // 兩個 secret 都沒設代表 admin endpoints 在這個環境未啟用
  if (!adminSecret && !uploadSecret) {
    return NextResponse.json(
      { error: 'admin endpoints disabled (ADMIN_SECRET not configured)' },
      { status: 503 },
    );
  }

  const headerAdmin = req.headers.get('x-admin-secret');
  const headerUpload = req.headers.get('x-upload-secret');

  const adminMatch = !!adminSecret && !!headerAdmin && headerAdmin === adminSecret;
  const uploadMatch = !!uploadSecret && !!headerUpload && headerUpload === uploadSecret;

  if (!adminMatch && !uploadMatch) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}
