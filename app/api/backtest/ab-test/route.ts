/**
 * POST /api/backtest/ab-test
 *
 * A/B 測試回測 — SSE 串流回傳進度
 *
 * Body: { market, fromDate, toDate, sampleInterval?, topN?, quintiles? }
 *
 * SSE events:
 *   status     — 文字狀態更新
 *   date_start — 開始處理某日期
 *   date_done  — 某日期完成
 *   complete   — 全部完成（含完整結果）
 *   error      — 錯誤
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ABTestEngine, ABTestProgressEvent, ABTestConfig } from '@/lib/backtest/ABTestEngine';
import { MarketId } from '@/lib/scanner/types';

export const maxDuration = 300; // Vercel Hobby 方案上限

const schema = z.object({
  market:         z.enum(['TW', 'CN']).default('TW'),
  fromDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDate:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sampleInterval: z.number().int().min(1).max(20).default(5),
  topN:           z.array(z.number().int().min(1).max(20)).default([1, 3, 5]),
  quintiles:      z.boolean().default(true),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ type: 'error', message: parsed.error.issues[0].message })}\n\n`,
      { status: 400, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  const config: ABTestConfig = {
    ...parsed.data,
    market: parsed.data.market as MarketId,
  };

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ABTestProgressEvent) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Client disconnected
        }
      };

      try {
        const engine = new ABTestEngine();
        await engine.run(config, send);
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
