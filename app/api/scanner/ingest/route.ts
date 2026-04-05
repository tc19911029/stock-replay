/**
 * /api/scanner/ingest — 掃描前資料覆蓋率檢查 + 缺失補下載
 *
 * POST { market: 'TW' | 'CN', symbols: string[], asOfDate?: string }
 *
 * 回傳 CoverageReport，包含覆蓋率、補缺結果、dataStatus
 * 前端根據 dataStatus 決定是否繼續掃描或顯示警告
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { ensureCoverage } from '@/lib/datasource/MarketDataIngestor';

export const runtime = 'nodejs';
export const maxDuration = 180; // 3 分鐘（補缺可能需要時間）

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      market: 'TW' | 'CN';
      symbols: string[];
      asOfDate?: string;
    };

    const { market, symbols, asOfDate } = body;
    if (market !== 'TW' && market !== 'CN') {
      return apiError('market must be TW or CN', 400);
    }
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return apiError('symbols must be a non-empty array', 400);
    }

    const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();

    const report = await ensureCoverage(symbols, market, asOfDate, {
      fetchCandles: (symbol, date) => scanner.fetchCandles(symbol, date),
      maxIngestCount: 300,
      timeoutMs: 150_000, // 2.5 分鐘上限
    });

    return apiOk(report);
  } catch (err) {
    return apiError(String(err));
  }
}
