import { NextRequest } from 'next/server';
import { z } from 'zod';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { ScanSession, MarketId, MtfMode } from '@/lib/scanner/types';
import { saveScanSession, loadScanSession } from '@/lib/storage/scanStorage';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import { isWeekday } from '@/lib/utils/tradingDay';

export const runtime = 'nodejs';
export const maxDuration = 300;

const schema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  direction: z.enum(['long', 'short']).default('long'),
  mtf: z.enum(['daily', 'mtf', 'both']).default('both'),
  force: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }

  const { market, date, direction, mtf, force } = parsed.data;

  if (!isWeekday(date, market as 'TW' | 'CN')) {
    return apiOk({ skipped: true, reason: 'non-trading day (weekend)', date });
  }

  const marketId = market as MarketId;
  const modes: MtfMode[] = mtf === 'both' ? ['daily', 'mtf'] : [mtf as MtfMode];
  const results: Record<string, number> = {};

  try {
    const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
    const stocks = await scanner.getStockList();
    let marketTrend: unknown;

    // 今日掃描：注入 L2 快照的收盤報價，讓 fetchCandlesForScan 能合併今日 K 棒（staleDays=0）
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
    }).format(new Date());
    if (date >= todayStr) {
      try {
        const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
        const snap = await readIntradaySnapshot(market as 'TW' | 'CN', todayStr);
        if (snap && snap.quotes.length > 0) {
          const quotes = new Map<string, { open: number; high: number; low: number; close: number; volume: number; date?: string }>();
          for (const q of snap.quotes) {
            const code = q.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
            if (q.close > 0) {
              quotes.set(code, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume, date: snap.date });
            }
          }
          if (quotes.size > 0) {
            scanner.setRealtimeQuotes(quotes);
            console.log(`[scanner/backfill] 注入 L2 今日報價: ${quotes.size} 支 (${snap.date})`);
          }
        }
      } catch {
        // L2 注入失敗不影響掃描，只是結果可能落後一天
      }
    }

    for (const mode of modes) {
      const mtfEnabled = mode === 'mtf';

      // Skip if already exists (unless force)
      if (!force) {
        const existing = await loadScanSession(marketId, date, direction, mode);
        if (existing) {
          results[`${direction}-${mode}`] = existing.resultCount;
          continue;
        }
      }

      let scanResults: import('@/lib/scanner/types').StockScanResult[];

      if (direction === 'short') {
        const { candidates, marketTrend: mt } = await scanner.scanShortCandidates(
          stocks, date, mtfEnabled ? { ...ZHU_V1.thresholds, multiTimeframeFilter: true } : undefined,
        );
        scanResults = candidates;
        marketTrend = mt;
      } else {
        const out = await scanner.scanSOP(
          stocks, date, mtfEnabled ? { ...ZHU_V1.thresholds, multiTimeframeFilter: true } : undefined,
        );
        scanResults = out.results as import('@/lib/scanner/types').StockScanResult[];
        marketTrend = out.marketTrend;
      }

      // 資料品質守門：若今日掃描結果全部落後≥1天（L2 注入失敗），不覆蓋已有的 L4 好數據
      const avgStaleDays = scanResults.length > 0
        ? scanResults.reduce((s, r) => s + ((r as { dataFreshness?: { daysStale?: number } }).dataFreshness?.daysStale ?? 0), 0) / scanResults.length
        : 0;
      if (date >= todayStr && avgStaleDays >= 1) {
        console.warn(`[scanner/backfill] 今日掃描落後 ${avgStaleDays.toFixed(1)} 天（L2 注入失敗），不覆蓋 L4`);
        const existing = await loadScanSession(marketId, date, direction, mode);
        results[`${direction}-${mode}`] = existing?.resultCount ?? 0;
        continue;
      }

      const session: ScanSession = {
        id: `${market}-${direction}-${mode}-${date}-backfill`,
        market: marketId, date, direction,
        multiTimeframeEnabled: mtfEnabled,
        scanTime: new Date().toISOString(),
        resultCount: scanResults.length,
        results: scanResults,
      };

      await saveScanSession(session);
      results[`${direction}-${mode}`] = scanResults.length;
    }

    return apiOk({ results, date, direction, marketTrend });
  } catch (err) {
    console.error('[scanner/backfill] error:', err);
    return apiError(String(err));
  }
}
