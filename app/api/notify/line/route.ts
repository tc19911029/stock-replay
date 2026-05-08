/**
 * @deprecated LINE Notify 服務 2025-03-31 已停止運作。
 * https://notify-bot.line.me/closing-announce
 *
 * 此 endpoint 保留檔案但回 410 Gone，避免任何殘留 caller 沉默失敗。
 * 未來改用 LINE Messaging API 或 Webhook 時再重寫。
 */
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: 'LINE Notify service was discontinued on 2025-03-31. Use LINE Messaging API instead.',
      gone: true,
    },
    { status: 410 },
  );
}
