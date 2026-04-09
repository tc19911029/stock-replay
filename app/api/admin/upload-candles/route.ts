/**
 * /api/admin/upload-candles — 批量上傳 K 線資料到 Blob
 *
 * POST { files: Array<{ key: string; content: string }> }
 * Header: x-upload-secret: <UPLOAD_SECRET>
 *
 * 僅供本地腳本呼叫，上線後應移除或加強保護
 */
import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface UploadFile {
  key: string;    // e.g. "candles/TW/0050.TW.json"
  content: string; // JSON string
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-upload-secret');
  if (!secret || secret !== process.env.UPLOAD_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { files } = await req.json() as { files: UploadFile[] };
  if (!Array.isArray(files) || files.length === 0) {
    return NextResponse.json({ error: 'files array required' }, { status: 400 });
  }

  const results = await Promise.allSettled(
    files.map(f => put(f.key, f.content, { access: 'private', addRandomSuffix: false, allowOverwrite: true }))
  );

  const ok = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  return NextResponse.json({ ok, failed, total: files.length });
}
