/**
 * POST /api/backtest/rule-group-analysis
 *
 * 規則群組回測分析 — SSE 串流回傳進度
 *
 * Body: { markets?: ('TW' | 'CN')[] }
 *   - 預設兩邊都跑
 *
 * SSE events:
 *   status          — 文字狀態更新
 *   fetching        — 資料抓取進度
 *   analyzing       — 分析進度
 *   market_complete — 單一市場完成
 *   complete        — 全部完成
 *   error           — 錯誤
 */

import { NextRequest } from 'next/server';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { RuleGroupAnalyzer } from '@/lib/backtest/RuleGroupAnalyzer';
import { AnalysisProgressEvent } from '@/lib/backtest/ruleGroupAnalyzerTypes';

export const maxDuration = 600; // 10 分鐘

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const markets: ('TW' | 'CN')[] = body.markets ?? ['TW', 'CN'];
  const stockCount: number = body.stockCount ?? 100;
  const period: string = body.period ?? '1y';
  const options = { stockCount, period };

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AnalysisProgressEvent) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Client disconnected
        }
      };

      try {
        const analyzer = new RuleGroupAnalyzer();

        // 取得股票清單
        const twScanner = new TaiwanScanner();
        const cnScanner = new ChinaScanner();

        if (markets.includes('TW') && markets.includes('CN')) {
          // 兩邊都跑
          send({ type: 'status', market: 'TW', message: '正在取得台股清單...' });
          const twStocks = await twScanner.getStockList();

          send({ type: 'status', market: 'CN', message: '正在取得陸股清單...' });
          const cnStocks = await cnScanner.getStockList();

          await analyzer.analyzeAll(twStocks, cnStocks, send, options);
        } else if (markets.includes('TW')) {
          send({ type: 'status', market: 'TW', message: '正在取得台股清單...' });
          const twStocks = await twScanner.getStockList();
          const result = await analyzer.analyzeMarket('TW', twStocks, send, options);
          send({ type: 'complete', result: { tw: result, cn: result, comparison: { strongBoth: [], twOnly: [], cnOnly: [], weakBoth: [] }, createdAt: new Date().toISOString(), version: '1.0.0' } });
        } else {
          send({ type: 'status', market: 'CN', message: '正在取得陸股清單...' });
          const cnStocks = await cnScanner.getStockList();
          const result = await analyzer.analyzeMarket('CN', cnStocks, send, options);
          send({ type: 'complete', result: { tw: result, cn: result, comparison: { strongBoth: [], twOnly: [], cnOnly: [], weakBoth: [] }, createdAt: new Date().toISOString(), version: '1.0.0' } });
        }
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
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
