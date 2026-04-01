/**
 * POST /api/backtest/capital
 *
 * 回測模式 B：自訂資金完整交易流程型回測
 *
 * Body:
 * {
 *   config: CapitalSimConfig;
 *   dailyScanResults: Array<{ date: string; results: StockScanResult[] }>;
 *   forwardBySymbolDate: Record<string, ForwardCandle[]>; // key: `${symbol}_${date}`
 * }
 *
 * 注意：前瞻資料由客戶端取得後傳入，此端點只做純計算。
 * 建議分批傳入（例如每次傳30天），以避免請求體過大。
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { runCapitalSimulation } from '@/lib/backtest/CapitalSimulator';
import type { CapitalSimConfig } from '@/lib/backtest/CapitalSimulator';

export const runtime     = 'nodejs';
export const maxDuration = 60;

const configSchema = z.object({
  initialCapital:   z.number().positive(),
  market:           z.enum(['TW', 'CN']),
  direction:        z.enum(['long', 'short']).default('long'),
  positionMode:     z.enum(['full', 'fixed_pct', 'risk_based']).default('fixed_pct'),
  positionPct:      z.number().optional(),
  maxPositions:     z.number().int().min(1).max(10).default(1),
  rankingFactor:    z.enum(['composite', 'surge', 'smartMoney', 'histWinRate', 'sixConditions']).default('composite'),
  costFeeDiscount:  z.number().optional(),
});

const bodySchema = z.object({
  config:              configSchema,
  dailyScanResults:    z.array(z.object({
    date:    z.string(),
    results: z.array(z.any()),
  })),
  forwardBySymbolDate: z.record(
    z.string(),
    z.array(z.object({
      date:    z.string(),
      open:    z.number(),
      close:   z.number(),
      high:    z.number(),
      low:     z.number(),
      volume:  z.number().optional(),
      ma5:     z.number().optional(),
    }))
  ),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const { config, dailyScanResults, forwardBySymbolDate } = parsed.data;

  try {
    const result = runCapitalSimulation(
      config as CapitalSimConfig,
      dailyScanResults,
      forwardBySymbolDate,
    );

    return NextResponse.json(result);
  } catch (err) {
    console.error('[backtest/capital] error:', err);
    return NextResponse.json({ error: '資金模擬回測計算失敗' }, { status: 500 });
  }
}
