import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-upload-secret');
  const envSecret = process.env.UPLOAD_SECRET;
  return NextResponse.json({
    headerValue: secret,
    envSet: !!envSecret,
    envLength: envSecret?.length ?? 0,
    match: secret === envSecret,
    envFirst10: envSecret?.slice(0, 10),
  });
}
