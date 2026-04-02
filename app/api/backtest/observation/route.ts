/**
 * POST /api/backtest/observation
 *
 * 回測模式 A：選股後表現觀察型回測
 *
 * Body:
 * {
 *   scanResultsByDate: Array<{
 *     date: string;
 *     results: StockScanResult[];
 *   }>;
 *   forwardDataByDate: Record<string, Record<string, ForwardEntry>>;
 *   factor: 'composite' | 'surge' | 'smartMoney' | 'histWinRate' | 'sixConditions';
 *   market: 'TW' | 'CN';
 * }
 *
 * 設計說明：
 * - 掃描資料由客戶端傳入（避免 API 回測耗時過長）
 * - 前瞻資料也由客戶端取得後傳入（可並行呼叫 /api/backtest/forward）
 * - 此端點只做純計算（runObservationBacktest）
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { runObservationBacktest, type ForwardEntry } from '@/lib/backtest/ObservationBacktest';
import type { MarketId } from '@/lib/scanner/types';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime     = 'nodejs';
export const maxDuration = 30;

const forwardEntrySchema = z.object({
  symbol:      z.string(),
  nextOpen:    z.number().nullable().optional(),
  returnD1:    z.number().nullable().optional(),
  returnD2:    z.number().nullable().optional(),
  returnD3:    z.number().nullable().optional(),
  returnD5:    z.number().nullable().optional(),
  returnD10:   z.number().nullable().optional(),
  returnD20:   z.number().nullable().optional(),
  maxGain:     z.number().optional(),
  maxDrawdown: z.number().optional(),
});

const bodySchema = z.object({
  scanResultsByDate: z.array(z.object({
    date:    z.string(),
    results: z.array(z.any()),  // StockScanResult — already validated upstream
  })),
  forwardDataByDate: z.record(
    z.string(),
    z.record(z.string(), forwardEntrySchema)
  ),
  factor: z.enum(['composite', 'surge', 'smartMoney', 'histWinRate', 'sixConditions']).default('composite'),
  market: z.enum(['TW', 'CN']),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }

  const { scanResultsByDate, forwardDataByDate, factor, market } = parsed.data;

  try {
    const result = runObservationBacktest(
      scanResultsByDate,
      forwardDataByDate as Record<string, Record<string, ForwardEntry>>,
      factor,
      market as MarketId,
    );

    return apiOk(result);
  } catch (err) {
    console.error('[backtest/observation] error:', err);
    return apiError('觀察型回測計算失敗');
  }
}
