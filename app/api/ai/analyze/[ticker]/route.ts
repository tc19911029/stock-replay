import { NextRequest, NextResponse } from 'next/server';
import { runFullAnalysis } from '@/lib/ai/analysisEngine';
import type { AnalysisEventCallback } from '@/lib/ai/analysisEngine';
import { aggregateNews } from '@/lib/news/aggregator';
import { analyzeNewsSentiment } from '@/lib/news/sentiment';
import { getTWChineseName, getCNChineseName } from '@/lib/datasource/TWSENames';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import type { StockScanResult } from '@/lib/scanner/types';
import { getFundamentals, getInstitutional } from '@/lib/datasource/FinMindClient';

export const maxDuration = 120;

/**
 * GET /api/ai/analyze/:ticker
 * Returns a Server-Sent Events (SSE) stream.
 *
 * Event types:
 *   analyst    — one analyst completed (RoleAnalysis)
 *   debate     — one debater completed (DebateAnalysis)
 *   synthesis  — research director completed (SynthesisResult)
 *   complete   — full FullAnalysisResult (all roles done)
 *   error      — { message: string }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
): Promise<Response> {
  const { ticker } = await params;

  if (!ticker || !/^\d{4,6}$/.test(ticker)) {
    return NextResponse.json(
      { error: 'Invalid ticker format. Expected 4–5 digit Taiwan or 6-digit China stock code.' },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // Controller already closed (client disconnected)
        }
      };

      try {
        // Detect market from ticker length
        const isCN = /^\d{6}$/.test(ticker);

        let companyName: string;
        let symbol: string;
        let market: 'TW' | 'CN';

        if (isCN) {
          companyName = (await getCNChineseName(ticker)) ?? ticker;
          const suffix = (ticker.startsWith('6') || ticker.startsWith('9')) ? '.SS' : '.SZ';
          symbol = `${ticker}${suffix}`;
          market = 'CN';
        } else {
          companyName = (await getTWChineseName(ticker)) ?? ticker;
          symbol = `${ticker}.TW`;
          market = 'TW';
        }

        // Compute real scan data
        const scanner = isCN ? new ChinaScanner() : new TaiwanScanner();
        const scanData = await scanner.fetchStockScanData(symbol, companyName);

        let scan: StockScanResult;
        if (scanData) {
          scan = scanData;
        } else {
          // Minimal fallback if scanner completely fails
          scan = {
            symbol,
            name: companyName,
            market,
            price: 0,
            changePercent: 0,
            volume: 0,
            triggeredRules: [],
            sixConditionsScore: 0,
            sixConditionsBreakdown: { trend: false, position: false, kbar: false, ma: false, volume: false, indicator: false },
            trendState: '盤整',
            trendPosition: '未知',
            scanTime: new Date().toISOString(),
          };
        }

        // Fetch news + FinMind data in parallel
        const [newsItems, fundamentals, institutionalHistory] = await Promise.all([
          aggregateNews(ticker, companyName),
          getFundamentals(ticker).catch(() => null),
          getInstitutional(ticker, 10).catch(() => null),
        ]);
        const news = await analyzeNewsSentiment(ticker, newsItems);

        // Send news data upfront so the frontend can display it immediately
        if (news) send('news', news);

        // Stream event callback — fired as each role completes
        const onEvent: AnalysisEventCallback = (type, data) => {
          send(type, data);
        };

        // Run full analysis with streaming + real FinMind data
        const result = await runFullAnalysis(scan, news, onEvent, fundamentals, institutionalHistory);

        // Send the final complete result
        send('complete', result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('[analyze SSE] Error:', message);
        send('error', { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
    },
  });
}
