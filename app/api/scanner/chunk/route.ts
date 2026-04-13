import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

export const runtime = 'nodejs';
export const maxDuration = 300; // 陸股 5000 檔需要更多時間

import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { MarketId, ScanDiagnostics } from '@/lib/scanner/types';
import { resolveThresholds } from '@/lib/strategy/resolveThresholds';
import type { RealtimeQuoteForScan } from '@/lib/scanner/MarketScanner';

const scannerChunkSchema = z.object({
  market:     z.enum(['TW', 'CN']).default('TW'),
  stocks:     z.array(z.object({ symbol: z.string(), name: z.string() })).default([]),
  strategyId: z.string().optional(),
  thresholds: z.record(z.string(), z.unknown()).optional(),
  date:       z.string().optional(),
  /** 掃描模式：full=完整管線, pure=純朱家泓六大條件, sop=V2簡化版(六條件+戒律+淘汰法) */
  mode:       z.enum(['full', 'pure', 'sop']).default('full'),
  /** 排序因子（sop 模式用） */
  rankBy:     z.enum(['composite', 'surge', 'smartMoney', 'sixConditions', 'histWinRate']).default('sixConditions'),
  /** 方向：long=做多, short=做空 */
  direction:  z.enum(['long', 'short']).default('long'),
  /** 長線保護短線：多時間框架前置過濾 */
  multiTimeframeFilter: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = scannerChunkSchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }
  const market = parsed.data.market as MarketId;
  const stocks = parsed.data.stocks;
  const asOfDate = parsed.data.date || undefined;
  const thresholds = resolveThresholds({
    strategyId: parsed.data.strategyId,
    thresholds: parsed.data.thresholds as never,
  });

  // 長線保護短線：由前端開關覆蓋策略預設值
  if (parsed.data.multiTimeframeFilter) {
    thresholds.multiTimeframeFilter = true;
  }

  if (stocks.length === 0) {
    return apiOk({ results: [] });
  }

  try {
    const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
    const mode = parsed.data.mode;

    // 判斷是否為「今日掃描」：沒傳日期 或 傳的日期 >= 今天
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const isToday = !asOfDate || asOfDate >= todayStr;

    // 市場開盤檢查
    const { isMarketOpen, getLastTradingDay } = await import('@/lib/datasource/marketHours');
    const marketOpen = isToday && isMarketOpen(market);

    // effectiveDate 決定掃描目標日期：
    //   盤中 → undefined（今日路徑，合併即時報價）
    //   盤前/盤後 → 最後交易日（歷史路徑，避免假的今日 K 棒）
    //   指定歷史日期 → 用該日期
    let effectiveDate: string | undefined;
    let dataDate: string; // 回傳給前端的實際資料日期
    if (!isToday) {
      effectiveDate = asOfDate;
      dataDate = asOfDate!;
    } else if (marketOpen) {
      effectiveDate = undefined; // 今日路徑
      dataDate = todayStr;
    } else {
      // 盤前/盤後：降級為最後交易日的歷史掃描
      const lastDay = getLastTradingDay(market);
      effectiveDate = lastDay;
      dataDate = lastDay;
    }

    // L3 API fallback 預算控制
    // 歷史掃描：完全 local-only，零 API 呼叫（避免大量請求撞限流）
    // 今日掃描：嚴格限制 budget，最多 20 次 API 呼叫
    const isHistorical = effectiveDate && effectiveDate < todayStr;
    if (isHistorical) {
      scanner.setL3Budget(0); // 歷史掃描：pure local，不打任何 API
    } else if (process.env.VERCEL) {
      // 今日掃描：限制 API 呼叫數量，避免限流
      scanner.setL3Budget(20);
    }

    // 盤中粗篩：直接用 IntradayCache 快照過濾候選股，不走昂貴的 scanSOP
    // 若快照存在且夠新（< 5 分鐘），用快照粗篩 → 立即回傳 → 前端再做精篩
    // 備註：cron 每 2 分鐘寫入，5 分鐘 threshold 確保快取有效同時容忍輕微延遲
    if (marketOpen) {
      const { readIntradaySnapshot, isSnapshotFresh } = await import('@/lib/datasource/IntradayCache');
      const snapshot = await readIntradaySnapshot(market, todayStr);
      if (snapshot && isSnapshotFresh(snapshot, 300_000)) {
        // 核心條件粗篩（只用快照即時欄位）：
        // 1. 缺口：開盤偏離昨收 ≥ 2%（朱家泓核心條件之一）
        // 2. 幅度：漲幅絕對值 ≥ 5%（動能強）
        // 3. 有效報價：收盤 > 0 且成交量 > 0
        // 注意：此粗篩不回傳完整候選物件，只回傳 symbol/name 前端再做精篩
        const coarse = snapshot.quotes
          .filter(q => {
            if (q.close <= 0 || q.volume <= 0 || q.prevClose <= 0) return false;
            const gapPct = Math.abs(q.open - q.prevClose) / q.prevClose * 100;
            const isGap = gapPct >= 2; // 缺口 ≥ 2%
            const isSurge = Math.abs(q.changePercent) >= 5; // 動能強
            return isGap && isSurge;
          })
          .slice(0, 200)
          .map(q => ({ symbol: q.symbol, name: q.name }));
        if (coarse.length > 0) {
          return apiOk({
            results: coarse,
            marketTrend: null,
            mode: 'coarse',
            diagnostics: { totalStocks: snapshot.count, processedCount: coarse.length, filteredOut: snapshot.count - coarse.length, dataMissing: 0, coverageRate: 100, dataStatus: 'complete', tooFewCandles: 0 },
            dataDate: todayStr,
          });
        }
      }
    }

    // 盤中掃描：預取全市場即時報價
    if (marketOpen) {
      try {
        let quotes: Map<string, RealtimeQuoteForScan>;
        if (market === 'TW') {
          // 使用 mis.twse.com.tw 即時報價（非 STOCK_DAY_ALL 收盤統計）
          const { getTWSERealtimeIntraday } = await import('@/lib/datasource/TWSERealtime');
          const twseMap = await getTWSERealtimeIntraday();
          quotes = new Map();
          for (const [code, q] of twseMap) {
            quotes.set(code, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume, date: q.date });
          }
        } else {
          const { getEastMoneyRealtime } = await import('@/lib/datasource/EastMoneyRealtime');
          const emMap = await getEastMoneyRealtime();
          quotes = new Map();
          for (const [code, q] of emMap) {
            quotes.set(code, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
          }
        }
        if (quotes.size > 0) {
          scanner.setRealtimeQuotes(quotes);
        }
      } catch (err) {
        console.warn('[scanner/chunk] 即時報價預取失敗，使用本地數據:', err);
      }
    }

    let scanResult: { results: unknown[]; marketTrend: unknown; diagnostics?: ScanDiagnostics };
    if (mode === 'sop' && parsed.data.direction === 'short') {
      // V2 做空版：做空六條件 + 做空戒律
      const { candidates, marketTrend: mt, diagnostics } = await scanner.scanShortCandidates(stocks, effectiveDate, thresholds);
      scanResult = { results: candidates, marketTrend: mt, diagnostics };
    } else if (mode === 'sop') {
      // V2 做多版：六條件+戒律+淘汰法
      scanResult = await scanner.scanSOP(stocks, effectiveDate, thresholds, parsed.data.rankBy as 'sixConditions' | 'histWinRate');
    } else if (mode === 'pure' && effectiveDate) {
      scanResult = await scanner.scanListAtDatePure(stocks, effectiveDate, thresholds);
    } else if (mode === 'pure') {
      scanResult = await scanner.scanListAtDatePure(stocks, todayStr, thresholds);
    } else if (effectiveDate) {
      scanResult = await scanner.scanListAtDate(stocks, effectiveDate, thresholds);
    } else {
      scanResult = await scanner.scanList(stocks, thresholds);
    }

    const { results, marketTrend, diagnostics } = scanResult;
    return apiOk({ results, marketTrend, mode: parsed.data.mode, diagnostics, dataDate });
  } catch (err) {
    console.error('[scanner/chunk] error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    const isRateLimit = msg.includes('429') || msg.includes('rate') || msg.includes('limit');
    const isTimeout = msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('abort');
    const isBlobError = msg.includes('Blob') || msg.includes('blob') || msg.includes('BLOB');
    if (isRateLimit) {
      return apiError('精掃 API 限流中。建議：等待 1-2 分鐘後重試。', 429);
    }
    if (isTimeout) {
      return apiError(`精掃逾時（候選 ${stocks.length} 檔）。建議：稍後重試，系統會自動使用快取加速。`, 504);
    }
    if (isBlobError) {
      return apiError('K 線資料庫暫時無法存取。建議：等待 1 分鐘後重試。');
    }
    return apiError(`精掃異常：${msg.slice(0, 100)}。建議：重試一次。`);
  }
}
